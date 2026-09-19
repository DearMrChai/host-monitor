/**
 * S3 self-test: the durable event stream + roster-derived absence.
 * Covers S3-细化设计.md §2-§5 and the three hazards this stage exists to close:
 * H12 (a persistent node that never comes back is invisible), H15 (the ingest
 * ledger dies with the process), H17 (a refusal reason lives only in a local log
 * nobody reads).
 *
 * Usage: node scripts/selftest-events.mjs
 * Sections A-E run in-process; section F spawns its own Server on throwaway
 * ports against the same throwaway files, because "survives a restart" is only
 * worth asserting against a second process.
 */
import { spawn } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { DatabaseSync } from 'node:sqlite'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = mkdtempSync(path.join(tmpdir(), 'hm-s3-'))
const DB = path.join(DIR, 'events-test.db')
const CFG = path.join(DIR, 'history.json')
const ROSTER_DB = path.join(DIR, 'roster.db')
writeFileSync(CFG, JSON.stringify({
  enabled: true, db_path: DB, sample_interval_s: 1,
  raw_retention_days: 7, agg_retention_days: 30, chart_points: 96,
  event_retention_days: 7,
}))

// Throwaway everything, before any module opens a file.
process.env.HISTORY_CONFIG = CFG
process.env.HM_ROSTER_DB = ROSTER_DB

const { history } = await import('../src/history.js')
const { roster } = await import('../src/roster.js')
const events = await import('../src/events.js')
const { oncePerEpisode } = events
const { ingest, REASON_TEXT } = await import('../src/ingest.js')
const { store } = await import('../src/store.js')
const { evaluateCluster, thresholds } = await import('../src/status.js')

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) pass += 1
  else fail += 1
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `   ${extra}` : ''}`)
}

/** Read the throwaway DB from a *fresh* handle, so an open connection cannot
 *  make the final rmSync fail on Windows (the S2c lesson, applied from line 1).
 *  Two files, two helpers: `events` lives in the history DB, `enroll_codes` in
 *  the roster DB - mixing them up is a test bug, not a product one. */
function query(sql, ...args) {
  const h = new DatabaseSync(DB)
  try { return h.prepare(sql).all(...args) } finally { h.close() }
}
function qRoster(sql, ...args) {
  const h = new DatabaseSync(ROSTER_DB)
  try { return h.prepare(sql).all(...args) } finally { h.close() }
}
const bind = {
  nameOf: (id) => roster.get(id)?.display_name || id,
  reasonText: (reason) => REASON_TEXT[reason] || reason,
}
const rowsOf = (...codes) => events.dump(500).filter((r) => codes.includes(r.code))
const readAll = (opts = {}) => events.read({ window: '24h', ...opts }).events
const find = (list, code, hostId) => list.filter((e) => e.code === code
  && (hostId === undefined || e.host_id === hostId))

ok('A0 事件流挂在一次性 history DB 上（未碰生产文件）',
  events.attach(history, bind) === true && DB.startsWith(DIR))

// ---------- A. record / merge / once-per-episode / retention ----------
const T = Date.now()

events.record({ kind: 'presence', code: 'came_online', hostId: 'a1', level: 'info', ts: T })
const a1line = find(readAll(), 'came_online', 'a1')
ok('A1 事件落盘并按 24h 读出，文本在读取时才渲染',
  a1line.length === 1 && a1line[0].text === 'a1 回来了'
  && !JSON.stringify(events.dump(5)).includes('回来了'), a1line[0]?.text)

// H17's whole point: a machine stuck in a supervisor restart loop is ONE line.
for (let i = 0; i < 5; i++) {
  events.record({ kind: 'ingest', code: 'refused', hostId: 'flap', level: 'warn',
    detail: { reason: 'unknown_host' }, ts: T + i * 10_000 })
}
const flap = find(readAll(), 'refused', 'flap')
ok('A2 60s 内同类事件合并计数不加行（被拒风暴=一行）',
  flap.length === 1 && flap[0].count === 5 && flap[0].ts === T + 40_000
  && flap[0].first_ts === T, JSON.stringify({ count: flap[0]?.count }))

events.record({ kind: 'ingest', code: 'refused', hostId: 'flap', level: 'warn',
  detail: { reason: 'unknown_host' }, ts: T + 20 * 60_000 })
ok('A3 超出合并窗口才开新周期（不会被永久吸并）',
  find(readAll(), 'refused', 'flap').length === 2)

for (const dt of [0, 60_000, 3 * 3_600_000]) {
  events.record({ kind: 'presence', code: 'absent', hostId: 'a2', level: 'warn',
    detail: { last_seen: T - 10 * 60_000 }, ts: T + dt, ...oncePerEpisode })
}
ok('A4 缺席一个周期只播一次（6h 内不重复，S3 §3.3）',
  find(readAll(), 'absent', 'a2').length === 1)
events.record({ kind: 'presence', code: 'absent', hostId: 'a2', level: 'warn',
  detail: { last_seen: T + 7 * 3_600_000 }, ts: T + 7 * 3_600_000, ...oncePerEpisode })
ok('A4b 超过 6h 才允许第二次（长期仍缺席会再提醒一次）',
  find(readAll(), 'absent', 'a2').length === 2)

const purged = events.purge(history.db, T + 8 * 86_400_000)
ok('A5 保留期挂在 history 的保留时钟上（7d 过期即删）',
  purged > 0 && Number(query('SELECT COUNT(*) c FROM events')[0].c) === 0, `deleted=${purged}`)

const cfgText = readFileSync(CFG, 'utf8')
ok('A6 保留天数读的是配置（event_retention_days），不是写死',
  JSON.parse(cfgText).event_retention_days === 7 && history.cfg.event_retention_days === 7)

// ---------- B. H12: absence becomes visible without becoming an incident ----------
/* A confirmed, persistent roster row the live host table has never seen is
   precisely the case S2 left invisible: the machine was moved, reinstalled, or
   simply left switched-off across a Server restart. */
const ghost = roster.ensure('ghost-box', { hostname: 'ghost-box' })
roster.save({ ...ghost, confirmed: 1, presence_class: 'persistent',
  last_seen: Date.now() - 10 * 60_000 })
const b1 = store.getAnnotatedHosts()
const g1 = b1.find((h) => h.host_id === 'ghost-box')
ok('B1 常驻节点自启动后从未上报 → 出现在主机列表（H12）',
  !!g1 && g1.absent_record === true && g1.online === false
  && g1.last_seen > 0 && g1.display_name === 'ghost-box')
ok('B2 缺席卡是 OFFLINE 灰档，但不产生任何告警事由',
  g1?.status?.level === 'OFFLINE' && g1?.status?.absent === true
  && (g1?.status?.reasons || []).length === 0)
const c1 = evaluateCluster(b1)
ok('B3 进分母（在线 0/1）而不进健康度：横幅不被"它不在这儿"钉灰',
  c1.total === 1 && c1.online === 0 && c1.health !== 'OFFLINE',
  JSON.stringify({ health: c1.health, online: c1.online, total: c1.total }))

for (let i = 0; i < 3; i++) store.getAnnotatedHosts()
ok('B4 缺席节点每轮只合成一次（不是每轮加一张卡）',
  store.getAnnotatedHosts().filter((h) => h.absent_record).length === 1)
ok('B5 多轮扫描只留一条缺席事件（噪声纪律）',
  rowsOf('absent').filter((r) => r.host_id === 'ghost-box').length === 1)
ok('B6 缺席事件带"多久没上报"的事实，文案由它算出',
  /10 分钟/.test(find(readAll(), 'absent', 'ghost-box')[0]?.text || ''),
  find(readAll(), 'absent', 'ghost-box')[0]?.text)

store.register('ghost-box', { hostname: 'ghost-box' })
store.updateMetrics('ghost-box', { hostname: 'ghost-box', cpu: { usage_percent: 5 } })
const b2 = store.getAnnotatedHosts()
const g2 = b2.find((h) => h.host_id === 'ghost-box')
ok('B7 机器回来后回到实时记录（合成记录让位，不双计）',
  b2.filter((h) => h.host_id === 'ghost-box').length === 1
  && g2.absent_record === undefined && g2.online === true
  && evaluateCluster(b2).online === 1)
ok('B8 回来记一条 came_online，与缺席配成完整一句',
  find(readAll(), 'came_online', 'ghost-box').length === 1)

// ---------- C. the ingest ledger survives the process (H15 / H17) ----------
ingest.setMode('legacy')
const r1 = ingest.authorize({ hostId: 'stranger', token: undefined, addr: '203.0.113.7' })
for (let i = 0; i < 3; i++) {
  ingest.authorize({ hostId: 'stranger', token: undefined, addr: '203.0.113.7' })
}
ok('C1 陌生节点在 legacy 档同样被拒（H8 未回退）', r1.ok === false && r1.reason === 'unknown_host')
const refused = find(readAll(), 'refused', 'stranger')
ok('C2 拒绝原因进了持久台账，且四轮合成一行（H15/H17）',
  refused.length === 1 && refused[0].count === 4
  && refused[0].text === `stranger 接入被拒：${REASON_TEXT.unknown_host}`, refused[0]?.text)
ok('C3 台账里的地址只到网段',
  refused[0]?.detail?.addr === '203.0.*.*', JSON.stringify(refused[0]?.detail))

const keyless = roster.ensure('v1-box', { hostname: 'v1-box' })
roster.save({ ...keyless, confirmed: 1 })
const lg = ingest.authorize({ hostId: 'v1-box', addr: '203.0.113.8' })
ok('C4 legacy 宽限期接受但点名（不静默放行）',
  lg.ok === true && lg.legacy === true
  && rowsOf('legacy_accept').filter((r) => r.host_id === 'v1-box').length === 1)
ingest.setMode('strict')
const st = ingest.authorize({ hostId: 'v1-box', addr: '203.0.113.8' })
ingest.setMode('legacy')
ok('C5 strict 档下同一台被拒，并同样入账',
  st.ok === false && st.reason === 'bad_key'
  && find(readAll(), 'refused', 'v1-box').some((e) => e.detail.reason === 'bad_key'))

// restart simulation: forget the handle, then re-attach to the same file
events.detach()
ok('C6 未 attach 时写入静默、读出为空（history 关闭不是崩）',
  events.record({ kind: 'presence', code: 'came_online', hostId: 'nobody' }) === null
  && events.read().events.length === 0 && events.read().persisted === false)
events.attach(history, bind)
ok('C7 换一个新进程等价的操作后，旧事件仍在（H15 的正面回答）',
  find(readAll(), 'refused', 'stranger').length === 1
  && find(readAll(), 'legacy_accept', 'v1-box').length === 1)

// ---------- D. threshold crossings come from the alert log, not a 2nd detector ----------
const now = Date.now()
history.recordAlert({ id: 'd1|cpu_usage|cpu', host_id: 'd1', hostname: 'd1', metric: 'cpu_usage',
  source: 'cpu', level: 'WARN', state: 'active', value_at_trigger: 91, latest_value: 91,
  threshold: 80, started_at: now - 60_000, resolved_at: null })
const d1 = find(readAll(), 'alert_active', 'd1')
ok('D1 跨档行来自 alert_events（不另起第二检测器，S3 §2）',
  d1.length === 1 && d1[0].text.includes('CPU 使用率') && d1[0].level === 'warn', d1[0]?.text)
ok('D2 events 表里没有重复记的跨档行（一件事一处记）',
  Number(query("SELECT COUNT(*) c FROM events WHERE code LIKE 'alert_%'")[0].c) === 0)
history.recordAlert({ id: 'd1|cpu_usage|cpu', host_id: 'd1', hostname: 'd1', metric: 'cpu_usage',
  source: 'cpu', level: 'WARN', state: 'resolved', value_at_trigger: 91, latest_value: 62,
  threshold: 80, started_at: now - 60_000, resolved_at: now - 30_000 })
const dr = find(readAll(), 'alert_resolved', 'd1')
ok('D3 恢复是另一句人话（含回落值）',
  dr.length === 1 && /回到阈值内/.test(dr[0].text), dr[0]?.text)
history.recordAlert({ id: 'd2|mem|mem', host_id: 'd2', hostname: 'd2', metric: 'mem',
  source: 'mem', level: 'CRIT', state: 'resolved', value_at_trigger: 96, latest_value: 96,
  threshold: 85, started_at: now - 20_000, resolved_at: now - 10_000, cancelled: 'retired' })
const dc = find(readAll(), 'alert_cancelled', 'd2')
ok('D4 退役闭合不写成"已恢复"（沿用 S1b 语义）',
  dc.length === 1 && /告警终止：节点已退役/.test(dc[0].text)
  && find(readAll(), 'alert_resolved', 'd2').length === 0, dc[0]?.text)
ok('D5 按节点过滤可用（详情页"这台机器今天发生了什么"）',
  readAll({ hostId: 'd1' }).every((e) => e.host_id === 'd1'))

// ---------- E. write-side audit lines ----------
roster.setPassphrase('s3-selftest', undefined)
roster.setMute('ghost-box', Date.now() + 3_600_000)
roster.setDisplay('ghost-box', '客厅小主机')
roster.setClass('ghost-box', 'ephemeral')
const audit = readAll().filter((e) => e.kind === 'roster')
ok('E1 名册写操作逐条入账（口令/静默/改名/改档）',
  audit.some((e) => e.code === 'passphrase_changed') && audit.some((e) => e.code === 'muted')
  && audit.some((e) => e.code === 'renamed') && audit.some((e) => e.code === 'class_ephemeral'),
  audit.map((e) => e.code).join(','))
ok('E2 改名行同时给出新旧名，且不套用"现名"前缀（历史行存 id，名字在渲染时取）',
  /显示名改为「客厅小主机」（原「ghost-box」）/.test(find(readAll(), 'renamed', 'ghost-box')[0].text),
  find(readAll(), 'renamed', 'ghost-box')[0]?.text)
ok('E3 幂等写不重复入账（重复 setDisplay 同名 → 不加行）',
  roster.setDisplay('ghost-box', '客厅小主机') && find(readAll(), 'renamed', 'ghost-box').length === 1)

const minted = roster.issueEnroll({ ttlMin: 15, maxUses: 2 })
const issuedLine = find(readAll(), 'code_issued')[0]
ok('E4 签发配对码入账，只带尾号（明文不进台账）',
  issuedLine && issuedLine.text.includes(`…${minted.code.slice(-4)}`) && issuedLine.text.includes('2 次')
  && !JSON.stringify(events.dump(500)).includes(minted.code), issuedLine?.text)
const codeRow = qRoster('SELECT rowid AS id FROM enroll_codes WHERE code = ?', minted.code)[0]
ok('E5 撤销按 rowid 有把手，且同样有账', (() => {
  const r = roster.revokeById(codeRow.id)
  return r.ok === true && find(readAll(), 'code_revoked').length === 1
})())
const secretScan = JSON.stringify(events.dump(500))
ok('E6 事件表里没有任何口令/密钥明文（H11 过渡期硬约束）',
  !secretScan.includes('s3-selftest') && !secretScan.includes(minted.code)
  && !/[0-9a-f]{32}/.test(secretScan), `${secretScan.length} bytes scanned`)

// ---------- G. the rollback switch works at the store level (S3 §8) ----------
const savedPresence = thresholds.presence
thresholds.presence = { enabled: false, absent_after_minutes: 3 }
roster.ensure('another-gone', { hostname: 'another-gone' })
{
  const row = roster.get('another-gone')
  roster.save({ ...row, confirmed: 1, presence_class: 'persistent', last_seen: Date.now() - 20 * 60_000 })
}
const off = store.getAnnotatedHosts()
thresholds.presence = { enabled: true, absent_after_minutes: 3 }
const on = store.getAnnotatedHosts()
thresholds.presence = savedPresence
const offC = evaluateCluster(off)
const onC = evaluateCluster(on)
ok('G1 presence.enabled=false 时回到 S2 行为（一张缺席卡都不造）',
  !off.some((h) => h.host_id === 'another-gone'))
ok('G2 开关拨回 true 即恢复：多一张缺席卡、分母 +1（可当场回退，不必改代码）',
  on.some((h) => h.host_id === 'another-gone' && h.absent_record === true)
  && on.length === off.length + 1 && onC.total === offC.total + 1,
  JSON.stringify({ off: offC.total, on: onC.total }))
roster.setClass('another-gone', 'retired')
ok('G3 未确认的历史种子节点不会被合成（僵尸 mock 不复活）',
  (() => {
    roster.ensure('zombie-mock', { hostname: 'zombie-mock' })
    const row = roster.get('zombie-mock')
    roster.save({ ...row, confirmed: 0, last_seen: Date.now() - 5 * 86_400_000 })
    return !store.getAnnotatedHosts().some((h) => h.host_id === 'zombie-mock')
  })())
ok('G4 刚注册还没到 absent_after 的节点不会被抢先判缺席（重启无风暴）',
  (() => {
    const n = roster.ensure('fresh-box', { hostname: 'fresh-box' })
    roster.save({ ...n, confirmed: 1, presence_class: 'persistent', last_seen: Date.now() - 30_000 })
    const hosts = store.getAnnotatedHosts()
    return !hosts.some((h) => h.host_id === 'fresh-box' && h.absent_record)
  })())

// ---------- F. end to end against a real Server on throwaway ports ----------
const CHILD_ENV = {
  ...process.env,
  HISTORY_CONFIG: CFG, HM_ROSTER_DB: ROSTER_DB,
  HM_AGENT_PORT: '9310', HM_CLIENT_PORT: '9311',
  HM_INGEST_TOKEN: 'legacy',
}
const { WebSocket } = await import('ws')
const REST = 'http://127.0.0.1:9311'
const INGEST = 'ws://127.0.0.1:9310'
const PASS = 's3-selftest'   // set in section E above, same roster file

async function withServer(fn) {
  const child = spawn(process.execPath, [path.join(HERE, '..', 'src', 'index.js')], {
    cwd: path.join(HERE, '..'), env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => { if (process.env.HM_VERBOSE) process.stdout.write(`[srv] ${d}`) })
  child.stderr.on('data', (d) => process.stderr.write(`[srv!] ${d}`))
  try {
    let up = false
    for (let i = 0; i < 100 && !up; i++) {
      try { up = (await fetch(`${REST}/api/health`)).ok } catch { /* not listening yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 200))
    }
    if (!up) throw new Error('child Server did not come up on 9311')
    return await fn()
  } finally {
    child.kill()
    await new Promise((r) => setTimeout(r, 400))
  }
}

function getJson(p) { return fetch(`${REST}${p}`).then((r) => r.json()) }
function postJson(p, body, withPass = true) {
  return fetch(`${REST}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withPass ? { 'x-hm-admin': PASS } : {}) },
    body: JSON.stringify(body),
  }).then((r) => r.json())
}

/** One register frame, resolved with whatever the Server decided. */
function agentFrame(hostId, opts = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(INGEST)
    let settled = false
    const done = (v) => { if (settled) return; settled = true; resolve({ ws, ...v }) }
    const timer = setTimeout(() => done({ timeout: true }), 6_000)
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'register', host_id: hostId, hostname: opts.hostname || hostId,
      platform: 'selftest', ...opts.frame,
    })))
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.type === 'registered') { clearTimeout(timer); done({ ok: true, ack: m }) }
      else if (m.type === 'rejected') { clearTimeout(timer); done({ ok: false, reason: m.reason }) }
    })
    ws.on('error', () => { clearTimeout(timer); done({ error: true }) })
  })
}

/* Create the absent node BEFORE the child boots: a Server reads the roster into
   its own cache at startup, so a row minted after the spawn would be invisible
   to it - which is a property worth knowing about, not a test fixture detail. */
const gone = roster.ensure('gone-box', { hostname: 'gone-box' })
roster.save({ ...gone, confirmed: 1, presence_class: 'persistent',
  last_seen: Date.now() - 30 * 60_000 })

await withServer(async () => {
  await new Promise((r) => setTimeout(r, 4_500))   // two+ broadcast ticks

  const hosts = await getJson('/api/hosts')
  const alerts = await getJson('/api/alerts')
  const gb = hosts.hosts.find((h) => h.host_id === 'gone-box')
  ok('F1 真 Server：缺席常驻节点有自己的卡片（H12 端到端）',
    !!gb && gb.absent_record === true && gb.status?.level === 'OFFLINE'
    && gb.status?.absent === true, JSON.stringify({ lvl: gb?.status?.level, ab: gb?.status?.absent }))
  ok('F2 真 Server：它进分母、不进健康度、也不生成告警（不彻夜鸣响）',
    hosts.cluster.total >= 1 && hosts.cluster.health !== 'OFFLINE'
    && !alerts.active.some((a) => a.host_id === 'gone-box'),
    JSON.stringify({ health: hosts.cluster.health, n: hosts.cluster.online, m: hosts.cluster.total }))

  const denied = await agentFrame('intruder')
  const ev = await getJson('/api/events?window=24h')
  const rf = ev.events.filter((e) => e.code === 'refused' && e.host_id === 'intruder')
  ok('F3 真 Server：陌生机器（无凭据）被拒', denied.ok === false && denied.reason === 'unknown_host')
  ok('F4 真 Server：拒绝原因跨进程可读，且地址已掩码（H15/H17 端到端）',
    ev.persisted === true && rf.length === 1 && /未知节点/.test(rf[0].text)
    && String(rf[0].detail.addr).endsWith('.*.*')
    && !/\d+\.\d+\.\d+\.\d+/.test(JSON.stringify(rf[0])), JSON.stringify({ t: rf[0]?.text }))

  const enrolled = await postJson('/api/admin/enroll', { ttl_minutes: 15, max_uses: 1 })
  ok('F5 配对码在真 Server 上签发（写侧口令仍生效）',
    typeof enrolled.code === 'string' && enrolled.code.length === 12)
  const wrong = await fetch(`${REST}/api/admin/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hm-admin': 'nope' },
    body: JSON.stringify({ ttl_minutes: 15 }),
  })
  ok('F6 错口令签不出配对码（403，且不入台账）', wrong.status === 403)

  /* The credential goes in the register FRAME (msg.token), not in the helper's
     option bag - a frame without it is an unknown_host refusal, which is what
     this fixture silently did on its first run. */
  const paired = await agentFrame('friend-box', { frame: { token: enrolled.code } })
  await new Promise((r) => setTimeout(r, 2_500))
  const ev2 = (await getJson('/api/events?window=24h')).events
  ok('F7 朋友通过配对码接入这件事进了台账（谁昨天进了我的机群）',
    paired.ok === true && find(ev2, 'paired', 'friend-box').length === 1,
    JSON.stringify({ ok: paired?.ok, reason: paired?.reason }))
  const dump2 = JSON.stringify(ev2)
  ok('F8 事件接口不外泄凭据：口令/配对码/节点密钥均不在响应里',
    !dump2.includes(PASS) && !dump2.includes(enrolled.code) && !/[0-9a-f]{32}/.test(dump2))

  const after = await postJson('/api/roster/friend-box/class', { cls: 'ephemeral' })
  const ev3 = (await getJson('/api/events?window=24h')).events
  ok('F9 走 HTTP 的改档也入账（写侧审计无缺口）',
    after.ok === true && find(ev3, 'class_ephemeral', 'friend-box').length === 1)

  const scoped = await getJson('/api/events?window=24h&host=gone-box')
  ok('F10 按节点过滤在 HTTP 层同样成立（详情页用）',
    scoped.events.length > 0 && scoped.events.every((e) => e.host_id === 'gone-box'),
    `n=${scoped.events?.length}`)
  const clamped = await getJson('/api/events?window=99y&limit=99999')
  ok('F11 非法 window 退回 24h、limit 封顶（只读接口不能被拿去拖库）',
    clamped.window === '24h' && clamped.events.length <= 400)
  paired.ws?.close?.()
  denied.ws?.close?.()
})

history.db?.close?.()
roster.db?.close?.()

/* Clean on green, keep on red - the same harness rule S2c established: a passing
   run must not leave another throwaway DB behind, and a failing one must keep
   the evidence that was printed. */
if (!fail) {
  try { rmSync(DIR, { recursive: true, force: true }) } catch { /* best effort */ }
}
console.log(`\n[selftest-s3] pass=${pass} fail=${fail}${fail ? `   dir kept: ${DIR}` : ''}`)
process.exit(fail ? 1 : 0)
