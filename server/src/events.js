/**
 * Durable event stream (S3): "what changed in this fleet in the last 24 hours".
 * Contract: S3-细化设计.md §2-§5.
 *
 * Why this exists at all: the board otherwise answers "what is true right now",
 * which is the question nobody asks at 11pm. The one real decision this product
 * has driven so far came from noticing a *change* (显存占用高 -> 朋友的内核改完了
 * -> 模型能试了). Changes need a log, and a log that dies on restart is not one
 * (H15: the ingest ring buffer is 20 rows in memory; H17: a refusal reason is
 * otherwise only in a local log nobody reads).
 *
 * Three rules this module exists to enforce:
 *  1. One fact, one source. Threshold crossings are NOT recorded here - they
 *     already live in `alert_events` (debounced, with started/resolved/cancelled
 *     and a reason taxonomy). A second crossing-detector reading samples_1m
 *     would disagree with the alert the user is looking at, and would be a
 *     second runtime truth next to thresholds.json (H9).
 *  2. The stream must not become the noise it is meant to replace. So: merged
 *     repeats (`count`), once-per-episode absence, and a silent first pass after
 *     a Server restart (see store.js).
 *  3. Stored rows are machine facts (`code` + `detail_json`), never prose. The
 *     Chinese text is rendered at read time, so wording can be fixed without
 *     rewriting history - and so a stored row can never carry a passphrase,
 *     a node key or a full peer address.
 *
 * Attaching is explicit (`attach(history, ...)` in index.js) rather than an
 * import of history.js: roster.js / ingest.js / store.js all record events, and
 * a `roster -> events -> history` import edge would make every self-test that
 * constructs a Roster open the *production* history DB on import. Not attached
 * means record() is a no-op and read() returns nothing - which is exactly the
 * `history.enabled: false` dev mode, not a failure.
 */
import { thresholds } from './config.js'

const WINDOWS = { '2h': 7_200_000, '24h': 86_400_000, '7d': 604_800_000 }
const DEFAULT_LIMIT = 120
const MAX_LIMIT = 400
// Repeats of the same (code, host) inside this window bump `count` instead of
// adding a row: a machine stuck in a supervisor restart loop is ONE line about a
// broken enrolment, not three hundred lines (S3 §3.2). Local-tunable because the
// right value depends on how noisy a fleet is - a 3-node home bench and a 30-node
// one do not want the same window (S5, alongside H18's thresholds).
// Clamped here as well as on the write side: this value widens a dedupe window,
// and a runaway one would silently swallow distinct events.
const mergeWindowMs = () => Math.min(Math.max(
  (Number(thresholds.events?.merge_seconds) || 60) * 1000, 5_000), 3_600_000)
// Absence is announced once per episode; a node that stays away for a day gets
// one line, not a daily reminder.
const ABSENT_ONCE_MS = 6 * 3_600_000

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    first_ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    host_id TEXT,
    level TEXT NOT NULL DEFAULT 'info',
    code TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    count INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_code ON events(code, host_id, ts);
`

/** @type {{db: import('node:sqlite').DatabaseSync, days: number}|null} */
let handle = null
let nameOf = (id) => id
let reasonTextOf = (reason) => reason

/** Metric keys as the alert engine names them -> what to call them in a line. */
const METRIC_TEXT = {
  cpu_usage: 'CPU 使用率',
  cpu_temp: 'CPU 温度',
  mem: '内存占用',
  disk: '磁盘占用',
  gpu_temp: 'GPU 温度',
  rtt_ms: '链路延迟',
  packet_loss: '丢包率',
  offline: '在线状态',
}
/** Why an alert was cancelled (S1b taxonomy + S3's 缺席) -> honest wording. */
const CANCELLED_TEXT = {
  reclassified: '节点改了归属',
  retired: '节点已退役',
  stale: 'Server 重启后再无数据',
  absent: '改判缺席',
}

/** Which evaluation entry raised (H22) - the two call sites index.js guards.
 *  An unknown token renders as itself, so a third entry added later still says
 *  something true instead of falling back to a wrong sentence - and the lookup
 *  is own-property only, because `detail_json` is read back off the disk and
 *  `EVAL_WHERE_TEXT['constructor']` would otherwise print a function. */
const EVAL_WHERE_TEXT = {
  broadcast: '周期广播',
  'client-connect': '客户端接入',
}
const evalWhereText = (w) => (typeof w === 'string' && Object.hasOwn(EVAL_WHERE_TEXT, w)
  ? EVAL_WHERE_TEXT[w] : (w || '未注明入口'))

export function attach(history, bind = {}) {
  if (!history?.enabled || !history.db) {
    console.log('[Events] history unavailable -> event stream not persisted')
    return false
  }
  if (typeof bind.nameOf === 'function') nameOf = bind.nameOf
  if (typeof bind.reasonText === 'function') reasonTextOf = bind.reasonText
  history.db.exec(SCHEMA)
  handle = { db: history.db, days: Number(history.cfg?.event_retention_days) || 7 }
  history.onCleanup(purge)
  console.log(`[Events] durable stream attached (kept ${handle.days}d, merged within ${mergeWindowMs() / 1000}s)`)
  return true
}

export const attached = () => handle !== null

/** Self-test / teardown hook: forget the DB without unloading the module. */
export function detach() { handle = null }

/** Registered on the history retention clock (S3 §3): one sweep, not four. */
export function purge(db, now = Date.now()) {
  if (!db && !handle) return 0
  const cut = now - (handle?.days ?? 7) * 86_400_000
  const r = (db || handle.db).prepare('DELETE FROM events WHERE ts < ?').run(cut)
  if (r.changes) console.log(`[Events] retention: -${r.changes} row(s)`)
  return r.changes
}

function parseDetail(row) {
  try { return JSON.parse(row.detail_json) || {} } catch { return {} }
}

/**
 * Append one event. Returns `{ id, merged }`, or null when it was dropped by the
 * once-per-episode rule (or when nothing is attached).
 */
export function record({ kind, code, hostId = null, level = 'info', detail = null,
  ts = Date.now(), mergeMs = mergeWindowMs(), onceMs = null }) {
  if (!handle) return null
  if (!kind || !code) return null
  const db = handle.db
  const id = hostId ?? null
  // Newest row with this exact (code, host) - the window check below decides
  // whether it is a repeat to merge or the start of a new episode.
  const last = db.prepare(
    'SELECT id, ts FROM events WHERE code = ? AND host_id IS ? ORDER BY id DESC LIMIT 1')
    .get(code, id)
  const win = onceMs ?? mergeMs
  if (last && win && ts - last.ts <= win) {
    if (onceMs) return null // stay quiet: same episode, already announced
    // The newest detail travels with the newest `ts`: a merged row renders one
    // line, and rendering the *first* event's detail would let a later change
    // inside the window be described by an earlier one. For `node_thresholds`
    // that is a lie with the right shape - set an override and clear it within
    // 60s and the stream says "改用自定义阈值" about a node that is back on
    // global values (selftest F2).
    db.prepare('UPDATE events SET count = count + 1, ts = ?, detail_json = ? WHERE id = ?')
      .run(ts, JSON.stringify(detail || {}), last.id)
    return { id: last.id, merged: true }
  }
  const r = db.prepare(`
    INSERT INTO events (ts, first_ts, kind, host_id, level, code, detail_json, count)
    VALUES (?,?,?,?,?,?,?,1)`).run(
    ts, ts, kind, id, level, code, JSON.stringify(detail || {}))
  return { id: Number(r.lastInsertRowid), merged: false }
}

/** Absence is once per episode; the node coming back ends the episode (S3 §3.3). */
export const oncePerEpisode = { onceMs: ABSENT_ONCE_MS, mergeMs: null }

/**
 * Threshold crossings, read straight from the alert lifecycle table (S3 §2).
 * An open alert yields its trigger line; a closed one yields the trigger plus
 * how it ended, so "恢复了 / 被你退役了 / 改判缺席了 / Server 重启后失联" stay four
 * different sentences (S3 §2: the closure kind is the fact, not the timestamp).
 */
function alertRows(db, from, hostId) {
  const out = []
  let rows = []
  try {
    rows = hostId
      ? db.prepare('SELECT * FROM alert_events WHERE started_at >= ? AND host_id = ? ORDER BY started_at DESC LIMIT 400')
        .all(from, hostId)
      : db.prepare('SELECT * FROM alert_events WHERE started_at >= ? ORDER BY started_at DESC LIMIT 400').all(from)
  } catch { return out } // no alert_events yet (fresh DB, history disabled)
  for (const a of rows) {
    const metric = METRIC_TEXT[a.metric] || a.metric
    const where = a.source && a.source !== a.metric ? `（${a.source}）` : ''
    const unit = /temp/.test(a.metric) ? '℃' : a.metric === 'rtt_ms' ? 'ms' : ''
    const value = a.value_at_trigger == null ? '' : ` 触发值 ${a.value_at_trigger}${unit}`
    const th = a.threshold == null ? '' : ` 阈值 ${a.threshold}${unit}`
    /* OFFLINE is a CRIT-grade fact everywhere else (the banner counts it, the
       card reds it); reading it as an grey info line was a second-class
       rendering of a first-class failure. */
    const level = (a.level === 'CRIT' || a.level === 'OFFLINE') ? 'crit'
      : a.level === 'WARN' ? 'warn' : 'info'
    /* 失联 is not a threshold crossing in any meaningful sense: the stored value
       is the staleness at the instant the rule fired (often 3s, because OFFLINE
       skips the debounce), so "越过阈值 阈值 15 触发值 3" was an arithmetic
       contradiction on a Chinese line. It gets its own three sentences. */
    const gone = a.metric === 'offline'
    out.push({
      ts: a.started_at, kind: 'alert', host_id: a.host_id, level,
      code: 'alert_active', count: 1,
      text: gone ? `节点失联（超过 ${a.threshold ?? '—'}s 无上报）`
        : `${metric}${where}越过阈值${th}${value}`,
      detail: { metric: a.metric, source: a.source, state: a.state, alert_level: a.level },
    })
    if (a.cancelled) {
      out.push({
        ts: a.resolved_at || a.started_at, kind: 'alert', host_id: a.host_id, level: 'info',
        code: 'alert_cancelled', count: 1,
        text: `${gone ? '失联' : `${metric}${where}`}告警终止：${CANCELLED_TEXT[a.cancelled] || a.cancelled}`,
        detail: { metric: a.metric, cancelled: a.cancelled },
      })
    } else if (a.state === 'resolved' && a.resolved_at) {
      out.push({
        ts: a.resolved_at, kind: 'alert', host_id: a.host_id, level: 'info',
        code: 'alert_resolved', count: 1,
        text: gone ? '节点恢复上报，失联告警结束'
          : `${metric}${where}回到阈值内${a.latest_value == null ? '' : `（${a.latest_value}${unit}）`}`,
        detail: { metric: a.metric, latest_value: a.latest_value },
      })
    }
  }
  return out
}

/** code + detail -> the one Chinese line the panel shows. Wording lives here. */
function render(row, detail) {
  const who = row.host_id ? nameOf(row.host_id) : '（无名册节点）'
  switch (row.code) {
    case 'came_online': return `${who} 回来了`
    case 'went_offline': return `${who} 离场（临时在场节点，不报警）`
    case 'absent': {
      const mins = Math.max(1, Math.round((row.ts - (detail.last_seen ?? row.ts)) / 60_000))
      return `${who} 自上次在场起已 ${mins >= 60 ? `${Math.round(mins / 60 * 10) / 10} 小时` : `${mins} 分钟`}没有上报`
    }
    case 'refused': return `${who} 接入被拒：${reasonTextOf(detail.reason) || '原因未知'}`
    case 'paired': return `${who} 通过配对码接入${detail.remaining === null || detail.remaining === undefined ? '' : `（该配对码剩余 ${detail.remaining} 次）`}`
    case 'legacy_accept': return `${who} 未带凭据接入（legacy 宽限期）`
    case 'drift': return `${who}：${reasonTextOf(detail.reason) || '接入异常（已接受并记账）'}`
    case 'class_persistent': return `${who} 定为常驻节点（计入健康度与分母）`
    case 'class_ephemeral': return `${who} 改为临时在场（不再生成告警）`
    case 'class_retired': return `${who} 已退役（看板与所有聚合中移除，历史保留）`
    // Not prefixed with `who`: the panel already shows the node, and the current
    // name would make the line read "客厅小主机 显示名改为 客厅小主机".
    case 'renamed': return `显示名改为「${detail.to}」${detail.from && detail.from !== detail.to ? `（原「${detail.from}」）` : ''}`
    case 'muted': return `${who} 告警静默至 ${detail.until_text || '今天结束'}`
    case 'unmuted': return `${who} 取消静默`
    // S6 §5: config writes are rare and consequential, so each one is a line.
    // Values are deliberately absent (the stream is readable without a
    // passphrase); the current value is one GET away at /api/config.
    case 'profile': return `${who} 档案更新：${(detail.keys || []).join('、') || '内容'}`
    case 'node_thresholds': return `${who} ${detail.cleared ? '取消自定义阈值（回落全局）' : `改用自定义阈值：${(detail.keys || []).join('、') || '未列出项'}`}`
    case 'node_probes': return `${who} ${detail.cleared ? '取消专属探测计划' : '设置专属探测计划（下次重连生效）'}`
    case 'thresholds_global': return `${detail.reset ? '全局阈值回落为出厂值' : `全局阈值已更新：${(detail.keys || []).join('、') || '未列出项'}`}`
    case 'probes_global': return '全局探测计划已更新（各 Agent 下次重连取用）'
    case 'code_issued': return `签发配对码 …${detail.tail || '?'}（${detail.ttl_minutes} 分钟 / ${detail.max_uses ? `${detail.max_uses} 次` : '不限次'}）`
    case 'code_revoked': return `撤销配对码 …${detail.tail || '?'}`
    case 'passphrase_changed': return `管理口令已${detail.was_set ? '更换' : '设置'}`
    case 'demo_on': return `演示机群已开启（道具节点带「模拟-」前缀）`
    case 'demo_off': return `演示机群已关闭（道具节点退役，告警按「已退役」闭合）`
    // H22: the monitor reporting on itself. Deliberately not prefixed with a
    // node name - the failing thing is this Server, not a machine in the fleet.
    case 'evaluator_error': return `评估器异常已拦截（${evalWhereText(detail.where)}）：${detail.message || '原因未知'}；本轮快照跳过，Server 继续运行`
    default: return detail.text || row.code
  }
}

/**
 * The stream: durable events + alert-derived crossings, newest first.
 * Never throws and never leaks: masked addresses only, no token/passphrase
 * values, no fingerprint values (their *state* is the fact worth showing).
 */
export function read({ window = '24h', hostId = null, limit = DEFAULT_LIMIT, now = Date.now() } = {}) {
  const span = WINDOWS[window] || WINDOWS['24h']
  const from = now - span
  const cap = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  let rows = []
  if (handle) {
    rows = (hostId
      ? handle.db.prepare('SELECT * FROM events WHERE ts >= ? AND host_id = ? ORDER BY ts DESC LIMIT 400').all(from, hostId)
      : handle.db.prepare('SELECT * FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT 400').all(from)
    ).map((r) => {
      const detail = parseDetail(r)
      return {
        ts: r.ts, first_ts: r.first_ts, kind: r.kind, host_id: r.host_id,
        level: r.level, code: r.code, count: r.count, detail,
      }
    })
    rows.push(...alertRows(handle.db, from, hostId))
  }
  rows.sort((a, b) => b.ts - a.ts)
  const events = rows.slice(0, cap).map((e) => ({
    ...e,
    host_name: e.host_id ? nameOf(e.host_id) : null,
    text: e.text || render(e, e.detail || {}),
  }))
  return { window: WINDOWS[window] ? window : '24h', from, events, count: events.length,
    truncated: rows.length > cap, persisted: !!handle }
}

/** Self-test helper: everything recorded so far, raw (no window, no prose). */
export function dump(limit = 200) {
  if (!handle) return []
  return handle.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
    .map((r) => ({ ...r, detail: parseDetail(r) }))
}
