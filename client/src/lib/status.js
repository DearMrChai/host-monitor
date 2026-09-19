/**
 * Shared four-state semantics for the frontend (P1).
 * Color codes and sort rules mirror server/src/status.js contract (P1-细化设计 §1.2).
 */

export const LEVEL_RANK = { OK: 0, WARN: 1, CRIT: 2, OFFLINE: 3 }

export const STATUS_TEXT = {
  OK: '正常', WARN: '警告', CRIT: '严重', OFFLINE: '失联',
}

export const ROLE_LABELS = {
  db: 'DB', inference: '推理', desktop: '台式',
  laptop: '笔记本', display: '展示端', other: '其他',
}

// Lower weight = more critical, listed first among equals
export const ROLE_WEIGHTS = {
  inference: 0, db: 1, desktop: 2, laptop: 3, display: 4, other: 5,
}

export function hostLevel(host) {
  return host.status?.level || (host.online ? 'OK' : 'OFFLINE')
}

/* ---------- S1 roster presentation (never a fifth alert level) ----------
   ABSENT is a display state for "an ephemeral node that left". It must not
   enter LEVEL_RANK: ranking it would let a borrowed machine keep dragging the
   whole fleet's attention, which is exactly the defect S1 removes. */

export const CLASS_LABELS = { persistent: '常驻', ephemeral: '临时', retired: '已退役' }

export const CLASS_HINT = {
  persistent: '失联会报警，计入在线率与集群健康',
  ephemeral: '离场只标记不报警，且不进在线率分母',
  retired: '已从看板与全部分母移除，历史仍可查',
}

export function displayName(host) {
  return host?.display_name || host?.hostname || host?.host_id || '?'
}

/**
 * L0 truncation (S4 §1.3): at three metres a name is a landmark, not a label.
 * One function because the 8-char rule and the ellipsis must not be retyped at
 * each call site, and the full name stays available everywhere else.
 */
export function shortName(name, max = 8) {
  const s = String(name ?? '')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * Does this event row's own text already name the node? Some server sentences
 * carry it ("infer-142 未带凭据接入"), so a view that prefixes the node name of
 * its own accord prints it twice - and on the kiosk line, where the whole row is
 * 40 characters, the second copy buys nothing (S4 §1.3).
 *
 * One predicate for both surfaces: the panel and the wall must not disagree about
 * whether a row is already labelled, and the server's wording is not something the
 * display layer should keep in sync by hand.
 */
export function eventNamesHost(e) {
  const text = String(e?.text ?? '')
  return [e?.host_id, e?.host_name, e?.display_name]
    .some((n) => n && text.startsWith(String(n)))
}

export function isAbsent(host) {
  return !host.online && host.status?.absent === true
}

/* How an alert ended. The server distinguishes a real recovery from "you
   stopped caring about this node" and from "we stopped hearing about it"
   (S1b) - printing 已恢复 for either would claim a down machine came back. */
export function resolvedText(a) {
  const by = a?.cancelled || (a?.state === 'cancelled' ? 'reclassified' : null)
  if (by === 'retired') return '已退役·告警关闭'
  if (by === 'absent') return '已改判缺席·不再报警'
  if (by === 'reclassified') return '已改判临时·不再报警'
  if (by === 'stale') return '已失效·节点长期未上报'
  return '已恢复'
}

/* ---------- S6 §6 (H14): which alerts deserve the ear ----------
   A FROZEN alert is the Server holding a claim it can no longer back up with
   data: the process restarted and the Agent has not come back, or the machine
   stopped reporting inside the grace window. It stays on the board - the box
   may well be on fire, and the alternative is deleting an open alert because we
   lost sight of it - but it must not start the crit loop. "I rebooted the
   Server and it began screaming by itself" reads as a fault of the tool, and
   the same entry closes as 已失效 a few minutes later anyway.
   One predicate, because the one-shot and the loop are two call sites for one
   decision, and a frozen row that can silence the loop but still chime is worse
   than either alone. */

export function isFrozen(a) {
  return a?.frozen === true
}

/** Does any of these active alerts deserve sound right now? (CRIT/OFFLINE loop) */
export function critLoopWanted(active) {
  return (active || []).some(
    (a) => !isFrozen(a) && (a.level === 'CRIT' || a.level === 'OFFLINE'))
}

export const FROZEN_TAG = '该机未再上报'

export const FROZEN_HINT =
  'Server 手里已无这台机器的任何数据（刚重启，或它再没连上来）。'
  + '这条是冻结的旧结论：不鸣响，宽限期到点后自动标记为失效，不会写成"已恢复"。'

/* Two roads lead to 缺席, and they say different things about the Server
   (S5 §5.1): `restart` is "this process has never seen it since boot", `silence`
   is "this process watched it go quiet past the degrade window". Printing the
   first sentence for the second would tell the reader to go restart something
   that is fine. One function, because the panel and the board must not keep the
   server's vocabulary in sync by hand. */
export function absenceCause(host) {
  if (!host?.absent_record) return null
  return host.absent_by === 'silence' ? 'Server 运行期间静默超时' : '自 Server 重启后未再上报'
}

export function formatSeenLast(ts) {
  if (!ts) return '时间未知'
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const today = new Date().toDateString() === d.toDateString()
  return today ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`
}

/* "3 小时前" is the question an absence card actually asks; a clock time makes
   the viewer subtract against their own watch. Coarse on purpose - the value it
   is reading (roster.last_seen) is itself only persisted every 30s. */
export function formatAgo(ts, now = Date.now()) {
  if (!ts) return '时间未知'
  const m = Math.floor(Math.max(0, now - ts) / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时${m % 60 ? ` ${m % 60} 分` : ''}前`
  return `${Math.floor(h / 24)} 天前`
}

/* ---------- S3b: what deserves the top-left of the grid ----------
   LEVEL_RANK stays what it always was (severity of *this node*), and is
   deliberately NOT the card order. Ordering by it put a machine that is simply
   switched off (OFFLINE=3) above one that is overheating (CRIT=2), which is the
   H1 mistake in a milder form: the loudest thing on screen was "it isn't here",
   not "it is in trouble". So the grid sorts by attention, a separate scale:
   trouble first, absence after health, 离场 last of all. */

export const ATTENTION_TEXT = {
  crit: '严重', warn: '警告', offline: '失联', absent: '缺席', ok: '正常', away: '离场',
}

/** 0 = top-left. Lower is more urgent; never derived from LEVEL_RANK alone. */
export function attentionRank(host) {
  // Absence is the only thing that gets demoted - a node that is here and in
  // trouble keeps its band whatever its class is, or a borrowed laptop on fire
  // would sort below an idle server.
  if (isAbsent(host)) return host.presence_class === 'ephemeral' ? 6 : 3
  const level = hostLevel(host)
  if (level === 'CRIT') return 0
  if (level === 'WARN') return 1
  if (level === 'OFFLINE') return 2 // was here, now gone: a real loss
  return host.presence_class === 'ephemeral' ? 5 : 4
}

/** The load that breaks a tie inside one attention band. */
export function loadOf(host) {
  const m = host.metrics
  if (!m) return -1
  const gpus = (m.gpu || []).map((g) => g.usage_percent ?? 0)
  return Math.max(
    m.cpu?.usage_percent ?? -1,
    m.memory?.percent ?? -1,
    ...(gpus.length ? gpus : [-1]),
  )
}

export function sortHostsForOverview(hosts) {
  return [...hosts].sort((a, b) => {
    const aa = attentionRank(a), ab = attentionRank(b)
    if (aa !== ab) return aa - ab
    // Same band: the busier machine first - that is the one the viewer asks about.
    const la = loadOf(a), lb = loadOf(b)
    if (la !== lb) return lb - la
    const wa = ROLE_WEIGHTS[a.role] ?? ROLE_WEIGHTS.other
    const wb = ROLE_WEIGHTS[b.role] ?? ROLE_WEIGHTS.other
    if (wa !== wb) return wa - wb
    return displayName(a).localeCompare(displayName(b))
  })
}

export function formatUptime(seconds) {
  if (seconds == null) return null
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  if (d > 0) return `${d}天${h}时`
  if (h > 0) return `${h}时${Math.floor((seconds % 3600) / 60)}分`
  return `${Math.floor(seconds / 60)}分`
}

export const METRIC_LABELS = {
  cpu_usage: 'CPU占用', cpu_temp: 'CPU温度', mem: '内存',
  disk: '磁盘', gpu_temp: 'GPU温度', offline: '失联',
  rtt_ms: '链路延迟', packet_loss: '丢包率',
}

/**
 * The unit a metric's number carries. One function because the banner used to
 * hardcode "%" for everything but 失联, which printed "CPU温度 97%" — a wrong
 * fact on the loudest line in the UI. Anything new must land here, not at a
 * call site.
 */
export function unitFor(metric) {
  if (metric === 'rtt_ms') return 'ms'
  if (metric === 'offline') return 's'
  if (metric?.endsWith('temp')) return '°C'
  return '%'
}

export function formatReason(r) {
  const label = METRIC_LABELS[r.metric] || r.metric
  const isLink = r.metric === 'rtt_ms' || r.metric === 'packet_loss'
  const source = isLink ? ` ↔${r.source}`
    : (r.source && !['cpu', 'mem', 'heartbeat'].includes(r.source) && r.source !== r.metric
      ? ` ${r.source}` : '')
  const unit = unitFor(r.metric)
  return `${label}${source} ${r.value}${unit}（阈值 ${r.threshold}）`
}

// Device-only level (excludes link), for the topology block face color
export function deviceLevel(host) {
  if (!host.online) return 'OFFLINE'
  const c = host.status?.components || {}
  const levels = [c.cpu?.level, c.mem?.level, c.disk?.level,
    ...(c.gpu || []).map(g => g.level)].filter(Boolean)
  if (!levels.length) return null
  return levels.reduce((a, l) => (LEVEL_RANK[l] > LEVEL_RANK[a] ? l : a))
}
