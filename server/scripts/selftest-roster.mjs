/**
 * S1 self-test: roster + presence semantics + mute + admin passphrase, end to end.
 * Usage: node scripts/selftest-roster.mjs     (spins its own Server on 93xx)
 *
 * Covers S1-细化设计.md §8 items 1-6. Everything runs against throwaway DB files
 * in the system temp dir, so the dev/production data dir is never touched.
 * Set HM_VERBOSE=1 to see the child Server's stdout.
 */
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { DatabaseSync } from 'node:sqlite'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = mkdtempSync(path.join(tmpdir(), 'hm-s1-'))
const HISTORY_DB = path.join(DIR, 'history.db')
const ROSTER_DB = path.join(DIR, 'roster.db')
const CFG = path.join(DIR, 'history.json')
writeFileSync(CFG, JSON.stringify({
  enabled: true, db_path: HISTORY_DB, sample_interval_s: 5,
  raw_retention_days: 7, agg_retention_days: 30, chart_points: 96,
}))
process.env.HISTORY_CONFIG = CFG
process.env.HM_ROSTER_DB = ROSTER_DB

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `   ${extra}` : ''}`)
}

// Order matters: history.js owns the schema, so it is imported and seeded
// before roster.js, whose constructor then runs the real upgrade seed query.
const { history } = await import('../src/history.js')
const tsA = Date.now() - 3_600_000
const tsB = Date.now() - 7_200_000
const tsC = Date.now() - 3 * 86_400_000        // a long-dead dev mock
{
  const ins = history.db.prepare(
    'INSERT OR IGNORE INTO samples_raw (host_id, ts, cpu_usage, mem_percent) VALUES (?,?,?,?)')
  ins.run('old-a', tsA, 20, 30)
  ins.run('old-a', tsA - 5_000, 22, 30)
  ins.run('old-b', tsB, 10, 10)
  ins.run('old-c', tsC, 10, 10)
}
const { roster } = await import('../src/roster.js')
const { evaluateHost, evaluateCluster } = await import('../src/status.js')
const { alertEngine } = await import('../src/alerts.js')

// ---------- A. roster data layer ----------
ok('A1 升级种子：历史里的 host_id 以常驻身份回到名册',
  roster.get('old-a')?.presence_class === 'persistent' && roster.get('old-b') !== undefined)
ok('A2 种子的 last_seen 取该节点历史最大 ts',
  Math.abs((roster.get('old-a')?.last_seen ?? 0) - tsA) < 60_000)

ok('A3 首次注册即入册、默认常驻且待确认', (() => {
  roster.ensure('new-1', { hostname: 'NewOne', role: 'laptop' })
  const n = roster.get('new-1')
  return n.presence_class === 'persistent' && n.confirmed === 0 && n.enrolled_at > 0
})())

roster.setDisplay('new-1', '我的笔记本')
roster.ensure('new-1', { hostname: 'renamed-by-agent' })
ok('A4 显示名不被 Agent 上报覆盖（hostname 仍跟随硬件名）',
  roster.get('new-1').display_name === '我的笔记本'
  && roster.get('new-1').hostname === 'renamed-by-agent')

roster.ensure('demo-1', { hostname: 'gpu-worker-01', kind: 'demo' })
ok('A5 模拟节点由 Server 强制加“模拟-”前缀',
  roster.get('demo-1').display_name === '模拟-gpu-worker-01',
  roster.get('demo-1').display_name)

roster.setClass('old-b', 'retired')
ok('A6 退役可标注且顺带确认',
  roster.get('old-b').presence_class === 'retired' && roster.get('old-b').confirmed === 1)
ok('A7 退役节点不在 active() 而在 retired()',
  !roster.active().some((n) => n.host_id === 'old-b')
  && roster.retired().some((n) => n.host_id === 'old-b'))
ok('A8 未确认节点进入待确认清单，三天未见的老节点不骚扰',
  roster.unconfirmed().some((n) => n.host_id === 'new-1')
  && !roster.unconfirmed().some((n) => n.host_id === 'old-c')
  && roster.get('old-c')?.presence_class === 'persistent',
  `unconfirmed=${roster.unconfirmed().length}`)

roster.setMute('new-1', Date.now() + 3_600_000)
const muteOn = roster.isMuted('new-1') && Number(roster.mutedUntil('new-1')) > Date.now()
roster.setMute('new-1', null)
ok('A9 静默开/关都生效', muteOn && roster.isMuted('new-1') === false)
roster.setMute('new-1', 'today')
ok('A10 “今天之内”解析为当日 24 点内有效',
  roster.mutedUntil('new-1') > Date.now()
  && roster.mutedUntil('new-1') <= new Date().setHours(24, 0, 0, 0))
roster.setMute('new-1', null)
roster.setMute('new-1', Date.now() - 1)
ok('A11 过期的静默自动失效', roster.isMuted('new-1') === false)
roster.setMute('new-1', null)

/* The credential field is `node_key` since S2 (`token` was the S1 name for the
   same column). Keep asserting BOTH halves of the promise: the secret never
   leaves the process, and the public projection still tells the UI whether the
   node has one - otherwise a typo silently turns this test into a no-op. */
ok('A12 publicOf 不泄漏 enroll_token / fingerprint（S5 G1：库里也没有明文）', (() => {
  roster.ensure('sec-1', { hostname: 'sec', node_key: 'tok-secret', fingerprint: 'fp-secret' })
  const n = roster.get('sec-1')
  const pub = JSON.stringify(roster.publicOf('sec-1'))
  return !pub.includes('tok-secret') && !pub.includes('fp-secret')
    && !String(n.enroll_token).includes('tok-secret') && !!n.fingerprint
    && roster.keyMatches('sec-1', 'tok-secret')
    && roster.keyMatches('sec-1', 'tok-wrong') === false
    && roster.keyMatches('sec-1', '') === false
    && roster.publicOf('sec-1').has_credential === true
})())

// ---------- B. presence semantics (pure functions) ----------
const mk = (id, cls, online, metrics = null) => ({
  host_id: id, hostname: id, online, lastSeen: Date.now() - 60_000,
  presence_class: cls, metrics,
})
const hot = (id, cls) => mk(id, cls, true, {
  cpu: { usage_percent: 99, temperature_c: null },
  memory: { percent: 40 }, disk: { partitions: [] },
})
const withStatus = (h) => (h.status = evaluateHost(h), h)

const offPersistent = withStatus(mk('p2', 'persistent', false))
const offEphemeral = withStatus(mk('e1', 'ephemeral', false))
ok('B1 常驻失联 -> OFFLINE + offline reason（会告警）',
  offPersistent.status.level === 'OFFLINE' && offPersistent.status.absent === false
  && offPersistent.status.reasons.some((r) => r.metric === 'offline'))
ok('B2 临时失联 -> 仍是 OFFLINE 灰卡，但 absent 且零 reason（不告警）',
  offEphemeral.status.level === 'OFFLINE' && offEphemeral.status.absent === true
  && offEphemeral.status.reasons.length === 0)

// The V1 defect: one borrowed machine leaving pinned the banner grey forever.
const clCrit = evaluateCluster([withStatus(hot('p1', 'persistent')), offEphemeral])
ok('B3 满载的常驻机 + 离场的临时机 -> 健康度是 CRIT，不是被钉住的 OFFLINE',
  clCrit.health === 'CRIT' && clCrit.total === 1 && clCrit.online === 1
  && clCrit.presence.total === 1 && clCrit.presence.online === 0,
  JSON.stringify({ health: clCrit.health, online: clCrit.online, total: clCrit.total }))
const cl = evaluateCluster([withStatus(hot('p1', 'persistent')), offEphemeral, offPersistent])
ok('B3b 常驻机失联仍要 OFFLINE（归类不会削弱真告警）',
  cl.health === 'OFFLINE' && cl.total === 2 && cl.online === 1,
  JSON.stringify({ health: cl.health, online: cl.online, total: cl.total, presence: cl.presence }))
const cl2 = evaluateCluster([withStatus(hot('p1', 'persistent')), withStatus(mk('e1', 'ephemeral', true))])
ok('B4 临时机在场只计入 presence，不污染 online/total',
  cl2.total === 1 && cl2.online === 1 && cl2.presence.total === 1 && cl2.presence.online === 1,
  JSON.stringify(cl2.presence))
const cl3 = evaluateCluster([offEphemeral])
ok('B5 只剩临时机离场时健康度为 OK（V1“永远灰”缺陷已修）',
  cl3.health === 'OK' && cl3.total === 0, cl3.health)
ok('B6 聚合负载仍含在线临时机（物理事实不因归类而失真）',
  cl.aggregate.cpu.avg === 99, JSON.stringify(cl.aggregate.cpu))

/* B7/B8 (S1b): 🔕 must reach the fleet-level signal, otherwise silencing a
   machine does not silence anything the user actually looks at. Availability is
   the one thing it may never swallow. */
const mutedHot = withStatus(hot('p3', 'persistent'))
mutedHot.status.muted = true
const calm = withStatus(mk('p4', 'persistent', true,
  { cpu: { usage_percent: 5, temperature_c: null }, memory: { percent: 10 }, disk: { partitions: [] } }))
const clMuted = evaluateCluster([mutedHot, calm])
ok('B7 满载但已静默的常驻机不进集群健康度，且以 muted_count 可见',
  clMuted.health === 'OK' && clMuted.muted_count === 1 && clMuted.total === 2
  // Silencing an alert never erases the electricity: the load average still
  // includes it (99+5)/2 = 52, per B6.
  && clMuted.aggregate.cpu.avg === 52,
  JSON.stringify({ health: clMuted.health, muted: clMuted.muted_count, cpu: clMuted.aggregate.cpu.avg }))
const mutedOff = withStatus(mk('p5', 'persistent', false))
mutedOff.status.muted = true
ok('B8 静默不吞失联：被静默的失联常驻机仍是 OFFLINE',
  evaluateCluster([mutedOff]).health === 'OFFLINE')

// ---------- C. alert engine: debounce + mute (advance() directly, no sleeping) --
{
  const E = alertEngine.constructor
  const mkHost = (usage = 99) => withStatus(mk('p9', 'persistent', true, {
    cpu: { usage_percent: usage, temperature_c: null }, memory: { percent: 5 },
  }))
  const pendingOf = (e) => [...e.entries.values()].filter((x) => x.state === 'pending').length
  const t0 = Date.now() + 1_000_000

  const e1 = new E()
  e1.advance([mkHost()], t0)
  const after1 = { act: e1.getLists().active.length, pen: pendingOf(e1) }
  e1.advance([mkHost()], t0 + 2_000)
  e1.advance([mkHost()], t0 + 4_000)
  const after3 = e1.getLists().active.map((a) => a.metric)
  ok('C1 未静默：1 个周期只 pending，满 3 个周期才 active',
    after1.act === 0 && after1.pen === 1 && after3.includes('cpu_usage'),
    JSON.stringify({ after1, after3 }))

  roster.ensure('p9', { hostname: 'p9' })
  roster.setMute('p9', Date.now() + 3_600_000)
  const e2 = new E()
  for (let i = 0; i < 4; i++) e2.advance([mkHost()], t0 + i * 2_000)
  ok('C2 静默中的节点不产生任何告警（连 pending 都不建）',
    e2.getLists().active.length === 0 && e2.entries.size === 0,
    JSON.stringify([...e2.entries.values()].map((x) => `${x.metric}/${x.state}`)))

  roster.setMute('p9', null)
  for (let i = 0; i < 4; i++) e2.advance([mkHost()], t0 + 100_000 + i * 2_000)
  ok('C3 取消静默后告警照实出现（不是伪造的“已恢复”）',
    e2.getLists().active.some((a) => a.host_id === 'p9' && a.metric === 'cpu_usage'),
    JSON.stringify(e2.getLists().active.map((a) => `${a.host_id}/${a.metric}`)))

  // A muted node's already-active alert must freeze, not resolve.
  roster.setMute('p9', Date.now() + 3_600_000)
  for (let i = 0; i < 4; i++) e2.advance([mkHost(5)], t0 + 200_000 + i * 2_000)
  const frozen = e2.entries.get('p9|cpu_usage|cpu')
  ok('C4 静默期内活动告警冻结不消解且不可见',
    frozen?.state === 'active' && e2.getLists().active.length === 0)
  roster.setMute('p9', null)
  e2.advance([mkHost(5)], t0 + 300_000)
  ok('C5 解除静默后同一条告警重新可见（值回到真实的高位）',
    e2.getLists().active.some((a) => a.id === 'p9|cpu_usage|cpu'))

  /* C6/C7 (S1b): reclassifying or retiring a node is not a recovery. V1 would
     age the vanished reason into "已恢复" and tell the user a dead machine came
     back; the engine must close it as cancelled instead. */
  const e3 = new E()
  e3.advance([withStatus(mk('p9', 'persistent', false))], t0 + 400_000)
  const offWasActive = e3.getLists().active.some((a) => a.metric === 'offline')
  roster.setClass('p9', 'ephemeral')
  e3.advance([withStatus(mk('p9', 'ephemeral', false))], t0 + 402_000)
  const reclassified = e3.entries.get('p9|offline|heartbeat')
  ok('C6 改判临时：离线告警以 cancelled=reclassified 关闭，不伪装成恢复',
    offWasActive && reclassified?.state === 'resolved'
    && reclassified?.cancelled === 'reclassified',
    JSON.stringify(reclassified && { st: reclassified.state, by: reclassified.cancelled }))
  ok('C6b 前端能从 resolved 列表里拿到 cancelled 字段',
    e3.getLists().resolved.some((a) => a.id === 'p9|offline|heartbeat'
      && a.cancelled === 'reclassified'))

  const e4 = new E()
  for (let i = 0; i < 3; i++) e4.advance([mkHost()], t0 + 500_000 + i * 2_000)
  roster.setClass('p9', 'retired')
  e4.advance([], t0 + 600_000) // retired nodes are filtered out of the host list
  const retired = e4.entries.get('p9|cpu_usage|cpu')
  ok('C7 退役节点的活动告警以 cancelled=retired 关闭',
    retired?.state === 'resolved' && retired?.cancelled === 'retired'
    && e4.getLists().active.length === 0,
    JSON.stringify(retired && { st: retired.state, by: retired.cancelled }))
  roster.setClass('p9', 'persistent')

  /* C8 (S1b defect 8): the mute set must come from the roster, not from the
     live host list. After a Server restart the Agent has not reconnected yet,
     so advance() runs with hosts=[] - a frozen alert used to age out there and
     turn into a fake 已恢复 for a machine the user explicitly silenced. */
  const e5 = new E()
  for (let i = 0; i < 3; i++) e5.advance([mkHost()], t0 + 700_000 + i * 2_000)
  const e5Active = e5.entries.get('p9|cpu_usage|cpu')
  const wasActive = e5Active?.state === 'active'
  roster.setMute('p9', Date.now() + 3_600_000)
  for (let i = 0; i < 4; i++) e5.advance([], t0 + 800_000 + i * 2_000)
  ok('C8 静默态源于 roster：重启后主机表为空，冻结的告警不会伪装成已恢复',
    wasActive && e5Active.state === 'active' && e5Active.cancelled === undefined
    && e5.getLists().active.length === 0,
    JSON.stringify({ wasActive, st: e5Active?.state, by: e5Active?.cancelled }))
  roster.setMute('p9', null)
  e5.advance([mkHost()], t0 + 900_000)
  ok('C8b 重启期间静默未丢：解除后同一条告警原样回来',
    e5.getLists().active.some((a) => a.id === 'p9|cpu_usage|cpu' && a.state === 'active'),
    JSON.stringify(e5.getLists().active.map((a) => `${a.host_id}/${a.metric}`)))

  /* C9 (S1b defect 9): the same lie without any muting. restoreActive() puts
     yesterday's alerts back while the store is still empty, so a host the
     Server has never heard from in this process must not "recover" - and a node
     that never returns at all must not pin the banner forever either. */
  const e6 = new E()
  for (let i = 0; i < 3; i++) e6.advance([mkHost()], t0 + 1_000_000 + i * 2_000)
  const e6cpu = e6.entries.get('p9|cpu_usage|cpu')
  const e6WasActive = e6cpu?.state === 'active'
  for (let i = 0; i < 4; i++) e6.advance([], t0 + 1_100_000 + i * 2_000)
  ok('C9 主机完全未知时不判恢复：告警保持活动（重启窗口）',
    e6WasActive && e6cpu.state === 'active' && !e6cpu.cancelled,
    JSON.stringify({ was: e6WasActive, st: e6cpu?.state, by: e6cpu?.cancelled }))
  e6.advance([], t0 + 1_100_000 + 45 * 60_000) // past the grace window
  ok('C9b 长期未上报以 cancelled=stale 关闭，不写“已恢复”',
    e6cpu.state === 'resolved' && e6cpu.cancelled === 'stale',
    JSON.stringify({ st: e6cpu.state, by: e6cpu.cancelled }))
  // The grace must restart from the last time the host went unknown, not from
  // the very first blip: reporting again clears the clock.
  const e7 = new E()
  for (let i = 0; i < 3; i++) e7.advance([mkHost()], t0 + 2_000_000 + i * 2_000)
  const e7cpu = e7.entries.get('p9|cpu_usage|cpu')
  e7.advance([], t0 + 2_100_000)               // a first, brief unknown window
  e7.advance([mkHost()], t0 + 2_200_000)       // Agent is back and still alarming
  e7.advance([], t0 + 2_100_000 + 45 * 60_000) // dark again 45 min later
  ok('C9c 恢复上报会重置未上报计时，不会因早先的短暂缺席被误判失效',
    e7cpu.state === 'active' && !e7cpu.cancelled,
    JSON.stringify({ st: e7cpu.state, by: e7cpu.cancelled }))

  /* Section C persisted lifecycle rows for p9 into the shared history DB, and
     its last write left an *active* cpu alert. Section E boots a real Server on
     that same DB, which would then legitimately restore and freeze an alert for
     a host that never connects - correct behaviour, but noise for E's lists.
     Start E from a clean alert table. */
  history.db.prepare("DELETE FROM alert_events WHERE host_id = 'p9'").run()
}

// ---------- D. passphrase: default deny, scrypt only ----------
ok('D1 未设口令时写侧默认拒绝（hasPassphrase=false）', roster.hasPassphrase() === false)
ok('D2 口令过短被拒', roster.setPassphrase('12', null).ok === false)
ok('D3 设置口令成功', roster.setPassphrase('open-sesame', null).ok === true)
ok('D4 正确口令通过', roster.checkPassphrase('open-sesame') === true)
ok('D5 错误/空口令被拒',
  roster.checkPassphrase('open-sesamo') === false && roster.checkPassphrase('') === false)
ok('D6 改口令必须带原口令',
  roster.setPassphrase('another', 'wrong').ok === false
  && roster.setPassphrase('another', 'open-sesame').ok === true
  && roster.checkPassphrase('another') === true)
/* Read the DB directly to prove what actually landed on disk - but keep the
   handle: an open roster.db is what makes the final rmSync fail on Windows
   (locked file, directory left behind), so it gets closed with the rest. */
const metaDb = new DatabaseSync(ROSTER_DB)
const metaRows = metaDb.prepare('SELECT value FROM meta').all()
ok('D7 口令以 scrypt 散列入库，明文不落盘',
  metaRows.every((r) => String(r.value).startsWith('scrypt$'))
  && !JSON.stringify(metaRows).includes('another'),
  String(metaRows[0]?.value).slice(0, 20) + '…')

// ---------- E. end to end against a real Server on throwaway ports ----------
/* Section E is about roster semantics, and its agents are the v1 kind: no
   credential at all. S2 made credential-less *new* nodes refused by default, so
   this Server runs with the escape valve open; sections F/G cover the policy
   itself, including that legacy agents are accepted but never invisible. */
const CHILD_ENV = {
  ...process.env,
  HISTORY_CONFIG: CFG, HM_ROSTER_DB: ROSTER_DB,
  HM_AGENT_PORT: '9300', HM_CLIENT_PORT: '9301',
  HM_INGEST_TOKEN: 'off',
}
const { WebSocket } = await import('ws')
const REST = 'http://127.0.0.1:9301'
const INGEST = 'ws://127.0.0.1:9300'

async function withServer(fn, env = CHILD_ENV) {
  const child = spawn(process.execPath, [path.join(HERE, '..', 'src', 'index.js')], {
    cwd: path.join(HERE, '..'), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => { if (process.env.HM_VERBOSE) process.stdout.write(`[srv] ${d}`) })
  child.stderr.on('data', (d) => process.stderr.write(`[srv!] ${d}`))
  try {
    let up = false
    for (let i = 0; i < 100 && !up; i++) {
      try { up = (await fetch(`${REST}/api/health`)).ok } catch { /* not listening yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 200))
    }
    if (!up) throw new Error('child Server did not come up on 9301')
    return await fn()
  } finally {
    child.kill()
    await new Promise((r) => setTimeout(r, 400))
  }
}

/** The snapshot the UI actually consumes: hosts + cluster + alerts + new_nodes. */
function snapshot() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(REST)
    const timer = setTimeout(() => { ws.close(); reject(new Error('snapshot timeout')) }, 8_000)
    ws.on('message', (raw) => { clearTimeout(timer); ws.close(); resolve(JSON.parse(raw.toString())) })
    ws.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

function connectAgent(hostId, hostname, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(INGEST)
    let settled = false
    const ack = new Promise((r) => { ws.ackThen = r })
    const closed = new Promise((r) => { ws.closedThen = r })
    // S2: the register ack now carries the node key, and a refusal is an
    // application-level close - both are things the tests assert on.
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString())
        if ((m.type === 'registered' || m.type === 'rejected') && !settled) {
          settled = true
          ws.ackThen(m)
        }
      } catch { /* ignore non-JSON */ }
    })
    ws.on('close', (code, reason) => {
      ws.closeInfo = { code, reason: String(reason || '') }
      ws.closedThen(ws.closeInfo)
      if (!settled) { settled = true; ws.ackThen({ type: 'closed', code }) }
    })
    ws.ack = ack
    ws.closed = closed
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'register', host_id: hostId, hostname, platform: 'test', role: 'other', ...extra,
      }))
      ws.send(JSON.stringify({ type: 'metrics', host_id: hostId, hostname, cpu: { usage_percent: 10 } }))
      resolve(ws)
    })
    ws.on('error', reject)
  })
}

const post = async (p, body, admin) => {
  const r = await fetch(`${REST}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(admin ? { 'x-hm-admin': admin } : {}) },
    body: JSON.stringify(body),
  })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}
const get = async (p) => (await fetch(`${REST}${p}`)).json()

await withServer(async () => {
  const a = await connectAgent('live-1', 'LiveBox')
  const b = await connectAgent('live-2', 'FriendLaptop')

  const s0 = await snapshot()
  const l1 = s0.hosts.find((h) => h.host_id === 'live-1')
  ok('E1 Agent 注册即入册，快照带上名册字段',
    !!l1 && l1.presence_class === 'persistent' && l1.confirmed === false
    && l1.display_name === 'LiveBox' && l1.last_seen > 0,
    JSON.stringify(l1 && { cls: l1.presence_class, name: l1.display_name }))
  ok('E2 新节点出现在待确认引导列表', s0.new_nodes.includes('live-1'),
    `new_nodes=${s0.new_nodes.length}`)
  ok('E2b 快照告知前端写侧口令状态', s0.admin.passphrase_set === true)

  const noHeader = await post('/api/roster/live-1/class', { cls: 'retired' })
  ok('E3 缺口令头的写请求 403', noHeader.status === 403, `got ${noHeader.status}`)
  const denied = await post('/api/roster/live-1/class', { cls: 'ephemeral' }, 'nope')
  ok('E3b 错口令 403', denied.status === 403, `got ${denied.status}`)
  const badCls = await post('/api/roster/live-1/class', { cls: 'whatever' }, 'another')
  ok('E3c 非法类别 400', badCls.status === 400)

  const flip = await post('/api/roster/live-2/class', { cls: 'ephemeral' }, 'another')
  ok('E4 正确口令改类别生效',
    flip.status === 200 && flip.json.node.presence_class === 'ephemeral')
  const renamed = await post('/api/roster/live-1/name', { name: '我的游戏本' }, 'another')
  ok('E4b 改名接口生效', renamed.status === 200 && renamed.json.node.display_name === '我的游戏本')

  // Stay connected long enough for at least one 2s broadcast to sample both
  // hosts, otherwise E7 has no history rows to find.
  await new Promise((r) => setTimeout(r, 4_500))
  a.close(); b.close()
  await new Promise((r) => setTimeout(r, 17_000))   // past the 15s offline timeout

  const s1 = await snapshot()
  const ep = s1.hosts.find((h) => h.host_id === 'live-2')
  const alerts = s1.alerts.active.map((x) => `${x.host_id}/${x.metric}`)
  ok('E5 两台离场：常驻机进 OFFLINE 告警，临时机只标缺席',
    s1.cluster.health === 'OFFLINE' && s1.cluster.total === 1 && s1.cluster.online === 0
    && s1.cluster.presence.total === 1 && s1.cluster.presence.online === 0
    && ep?.status.absent === true && ep?.status.level === 'OFFLINE'
    && alerts.includes('live-1/offline') && !alerts.some((x) => x.startsWith('live-2')),
    JSON.stringify({ health: s1.cluster.health, alerts }))
  const offAlert = s1.alerts.active.find((x) => x.host_id === 'live-1')
  const epRow = s1.hosts.find((h) => h.host_id === 'live-2')
  ok('E5b 告警条目带名册显示名，缺席卡片带可持久化的上次在场时间',
    offAlert?.display_name === '我的游戏本' && epRow?.last_seen > 0,
    JSON.stringify({ dn: offAlert?.display_name, ls: epRow?.last_seen ? 'yes' : 'no' }))

  const muted = await post('/api/roster/live-1/mute', { hours: 1 }, 'another')
  const s2 = await snapshot()
  ok('E6 🔕 不静音失联：静默后 OFFLINE 告警仍可见',
    muted.status === 200
    && s2.hosts.find((h) => h.host_id === 'live-1')?.status.muted === true
    && s2.alerts.active.some((x) => x.host_id === 'live-1' && x.metric === 'offline'),
    JSON.stringify(s2.alerts.active.map((x) => `${x.host_id}/${x.metric}`)))
  await post('/api/roster/live-1/mute', { cancel: true }, 'another')

  const retire = await post('/api/roster/live-2/class', { cls: 'retired' }, 'another')
  const s3 = await snapshot()
  const hist = await get('/api/history/live-2?range=2h')
  ok('E7 退役节点从看板与全部分母消失，但历史仍可查',
    retire.status === 200 && !s3.hosts.some((h) => h.host_id === 'live-2')
    && s3.cluster.presence.total === 0 && s3.cluster.total === 1
    && hist.host_id === 'live-2' && hist.points >= 1, `points=${hist.points}`)
})

// restart: the roster is disk state, the store is not (acceptance item 4)
await withServer(async () => {
  const r = await get('/api/roster')
  const live1 = r.nodes.find((n) => n.host_id === 'live-1')
  ok('E8 Server 重启后名册、类别、口令均在磁盘上复原',
    live1?.presence_class === 'persistent' && live1.confirmed === false
    && r.retired.some((n) => n.host_id === 'live-2') && r.admin.passphrase_set === true)
  const s = await snapshot()
  ok('E9 重启不伪造在线：无 Agent 连接时分母为空、健康度 OK',
    s.hosts.length === 0 && s.cluster.health === 'OK', `hosts=${s.hosts.length}`)

  /* E11 (S1b defect 9, end to end): live-1's OFFLINE alert was still active
     when the first Server process was killed. restoreActive() puts it back, but
     with no Agent connected the store is empty - V1 aged it out on the first
     tick and printed 已恢复 for a machine that was still down, dropping it from
     the banner until the Agent happened to reconnect. */
  await new Promise((r) => setTimeout(r, 7_000)) // several ticks, still no Agent
  const sFrozen = await snapshot()
  const offRow = sFrozen.alerts.active.find((x) => x.host_id === 'live-1' && x.metric === 'offline')
  ok('E11 重启且无人上报时，离线告警冻结保持活动而不是伪恢复',
    !!offRow && offRow.state === 'active' && !offRow.cancelled
    && !sFrozen.alerts.resolved.some((x) => x.host_id === 'live-1' && x.metric === 'offline'),
    JSON.stringify({ act: sFrozen.alerts.active.map((x) => `${x.host_id}/${x.metric}`),
                     res: sFrozen.alerts.resolved.map((x) => `${x.host_id}/${x.metric}`) }))

  const c = await connectAgent('live-1', 'LAPTOP-RENAMED-BY-OS')
  const row = (await snapshot()).hosts.find((h) => h.host_id === 'live-1')
  ok('E10 重连后仍用名册显示名（系统主机名变化不覆盖用户改名）',
    row?.display_name === '我的游戏本', row?.display_name)
  c.close()
})

// ---------- F. S2: pairing codes, ingest policy, demo fleet (in-process) ----------
const { ingest } = await import('../src/ingest.js')
const { demoFleet } = await import('../src/demo.js')
const { store } = await import('../src/store.js')

/* F1-F2: the pairing code's own accounting. A code is a spend-limited voucher,
   so its lifecycle is worth testing apart from the socket path. */
const c1 = roster.issueEnroll({ ttlMin: 15, maxUses: 2, note: 'bench' })
ok('F1 配对码是 12 位 hex 且带 TTL/次数',
  /^[0-9a-f]{12}$/.test(c1.code) && c1.max_uses === 2
  && c1.expires_at - Date.now() > 14 * 60_000 && c1.expires_at - Date.now() <= 15 * 60_000)
const u1 = roster.consumeEnroll(c1.code, 'x-1')
const u2 = roster.consumeEnroll(c1.code, 'x-2')
ok('F2 逐次消费并记剩余；用完即死',
  u1.ok && u1.remaining === 1 && u2.ok && u2.remaining === 0
  && roster.consumeEnroll(c1.code, 'x-3').reason === 'code_used_up',
  JSON.stringify({ u1, u2 }))
ok('F2b 过期码按原因拒绝（不是静默放行）',
  roster.consumeEnroll(c1.code, 'x-4', c1.expires_at + 1).reason === 'code_expired')
ok('F2c 不存在的码 unknown_code',
  roster.consumeEnroll('ffffffffffff', 'x').reason === 'unknown_code')
ok('F2d 同一台机器重复用码，paired_ids 不重复',
  (() => {
    const c = roster.issueEnroll({ maxUses: 3 })
    roster.consumeEnroll(c.code, 'dup'); roster.consumeEnroll(c.code, 'dup')
    return JSON.stringify(roster.activeCodes().find((r) => r.code === c.code).paired_ids) === '["dup"]'
  })())

/* F3-F7: the three modes. setMode() is the test hook; production reads env. */
const legacyMode = ingest.setMode('legacy')
ok('F3 legacy（默认档）：陌生节点无凭据被拒',
  ingest.authorize({ hostId: 'ghost-1', addr: '198.51.100.7' }).ok === false)
{
  const ev = ingest.recentEvents()[0]
  ok('F3b 被拒进了台账，且地址只到网段',
    ev?.host_id === 'ghost-1' && ev?.reason === 'unknown_host'
    && ev?.addr === '198.51.*.*' && !/\.\d+\.\d+$/.test(ev.addr),
    JSON.stringify(ev))
}
const pc = roster.issueEnroll({ ttlMin: 5, maxUses: 1 })
const v1 = ingest.authorize({ hostId: 'pair-1', token: pc.code, addr: '198.51.100.8' })
ok('F4 有效配对码换来一个 32 位节点密钥',
  v1.ok && v1.paired && /^[0-9a-f]{32}$/.test(v1.node_key || ''))
store.register('pair-1', {
  hostname: 'PairBox', kind: 'agent', node_key: v1.node_key, confirmed: true,
  agent_version: '2.0.0', fingerprint: 'fp-a',
})
ok('F4b 配对即确认：不再进待确认引导，密钥已认、但库里存的是哈希（S5 G1）',
  roster.keyMatches('pair-1', v1.node_key) === true
  && roster.nodeKeyOf('pair-1') !== v1.node_key
  && roster.publicOf('pair-1').confirmed === true
  && roster.publicOf('pair-1').has_credential === true)
ok('F4c 密钥不出现在任何公开投影',
  !JSON.stringify(roster.publicOf('pair-1')).includes(v1.node_key))
ok('F4d 之后凭节点密钥直连；配对码不能复用',
  ingest.authorize({ hostId: 'pair-1', token: v1.node_key }).ok === true
  && ingest.authorize({ hostId: 'pair-2', token: pc.code }).reason === 'code_used_up')
roster.ensure('old-1', { hostname: 'OldBox' })
ok('F5 legacy 宽限：已入册但无密钥的 v1 Agent 可用，并且被点名',
  ingest.authorize({ hostId: 'old-1' }).ok === true && roster.keylessAgents().includes('old-1'))
ingest.setMode('strict')
ok('F5b strict 拒绝无密钥的老 Agent（reason=bad_key）',
  ingest.authorize({ hostId: 'old-1' }).reason === 'bad_key')
ok('F5c strict 仍接受带密钥节点',
  ingest.authorize({ hostId: 'pair-1', token: v1.node_key }).ok === true)
ingest.setMode('off')
ok('F5d off 是逃生阀：一切照旧', ingest.authorize({ hostId: 'whoever-9' }).ok === true)
ingest.setMode(legacyMode)
ok('F6 一条连接不能改写别的节点，也不接受未注册的连接',
  ingest.frameHostMatches('pair-1', 'pair-2') === false
  && ingest.frameHostMatches('pair-1', 'pair-1') === true
  && ingest.frameHostMatches('pair-1', undefined) === true
  && ingest.frameHostMatches(null, 'pair-1') === false)
ingest.authorize({ hostId: 'pair-1', token: v1.node_key, fingerprint: 'fp-b' })
ok('F7 指纹漂移：接受但在台账里留痕（重装系统不该把自己锁在外）',
  ingest.recentEvents().some((e) => e.reason === 'fingerprint_drift' && e.accepted === true))

/* F8-F9: the demo fleet. These assert the honesty rules from S2 §5 directly:
   props are marked, they move no real-fleet number, and off really is off. */
store.register('real-9', { hostname: 'RealBox', kind: 'agent', confirmed: true })
store.updateMetrics('real-9', {
  host_id: 'real-9', cpu: { usage_percent: 50 }, memory: { percent: 50 }, gpu: [],
})
const snap0 = store.getSnapshot()
demoFleet.attach(store).setEnabled(true)
demoFleet.tick()
const snap1 = store.getSnapshot()
const props = snap1.hosts.filter((h) => h.kind === 'demo')
/* H35 销账（他 09-22 夜裁"名单钉死＋台数派生"）：**台数不再抄字面量**，从夹具
   `demoFleet.ids()` 拿（真源＝`src/demo.js` 那张 SCENARIO 表）。改守的东西换成**名单**：
   道具恰好是这五个 id。⇒ 加一台道具＝改夹具一处＋这里名字一处（不是三处）；
   而"不小心多注册进来一台"仍然当场红——名单会变长，`props.length === ids().length`
   也会在"该上线的没上线"时红。原来那三条 `=== 4` 的牙一条都没丢。
   正对照（09-22 夜实测）：往 SCENARIO 插一台 `sim-mutant` ⇒ **只有 F8 红**（名单不认它），
   F8b／G6 因为台数已派生所以照常绿——这正是"派生"该有的分工：数量自己跟，名单要人签。 */
const PROPS = ['sim-game', 'sim-media', 'sim-notebook', 'sim-tmpnote', 'sim-vectordb']
const gotIds = props.map((h) => h.host_id).sort()
const fixtureIds = demoFleet.ids().sort()
ok(`F8 道具名单钉死（${PROPS.length} 台，台数从夹具派生），名字一律带 模拟- 前缀`,
  gotIds.join() === PROPS.join() && props.length === fixtureIds.length
  && props.every((h) => h.display_name.startsWith('模拟-'))
  && props.every((h) => h.host_id.startsWith('sim-')),
  JSON.stringify({ got: gotIds, fixture: fixtureIds, names: props.map((h) => h.display_name) }))
ok('F8b 道具不进健康度/在线分母/聚合负载',
  snap1.cluster.total === snap0.cluster.total && snap1.cluster.health === snap0.cluster.health
  && snap1.cluster.demo.total === fixtureIds.length
  && snap1.cluster.aggregate.cpu.avg === snap0.cluster.aggregate.cpu.avg,
  JSON.stringify({ t0: snap0.cluster.total, t1: snap1.cluster.total,
                   demo: snap1.cluster.demo.total, agg: snap1.cluster.aggregate.cpu }))
{
  /* The card colour is the DEBOUNCED level (P2 contract), so one frame over the
     threshold is legitimately still OK. What must be true immediately is that
     the metric really crossed the line, that the real fleet does not move, and
     that nothing entered the alert list yet. G waits out the window for the
     other half of the claim: props do reach the alert panel once debounced. */
  const media = props.find((h) => h.host_id === 'sim-media')
  ok('F8c 影音道具的磁盘确实越了 WARN 线，真机健康度不动',
    media?.status.components.disk.level === 'WARN' && media.status.level === 'OK'
    && snap1.cluster.health === 'OK'
    && !snap1.alerts.active.some((a) => a.host_id === 'sim-media'),
    JSON.stringify({ inst: media?.status.components.disk, lvl: media?.status.level }))
}
{
  // The ephemeral prop needs to look like it left a while ago; waiting out the
  // store's own 15s timeout would only make the suite slow.
  store.hosts.get('sim-tmpnote').lastSeen = Date.now() - 20_000
  const s = store.getSnapshot()
  const note = s.hosts.find((h) => h.host_id === 'sim-tmpnote')
  ok('F8d 演示自带一台离场机：ABSENT 且绝不进告警',
    note?.status.absent === true && note.status.level === 'OFFLINE'
    && !s.alerts.active.some((a) => a.host_id === 'sim-tmpnote'))
}
ok('F8e 演示开关是服务端事实，重启后维持', roster.demoEnabledStored() === true)
demoFleet.setEnabled(false)
const snap2 = store.getSnapshot()
/* demoNodes() is a *roster* query ("every non-retired row tagged demo"), and
   section A hand-made such a row (demo-1) that nobody retired. The generator's
   own promise is narrower: none of ITS props is still live. */
const propsLeft = roster.demoNodes().filter((id) => id.startsWith('sim-'))
ok('F9 关掉演示是真的关：生成停了、节点退役、分母归零',
  !snap2.hosts.some((h) => h.kind === 'demo') && snap2.cluster.demo.total === 0
  && roster.demoEnabledStored() === false && propsLeft.length === 0
  && demoFleet.info().enabled === false && demoFleet.info().count === 0,
  JSON.stringify({ hosts: snap2.hosts.filter((h) => h.kind === 'demo').map((h) => h.host_id),
                   demo: snap2.cluster.demo, stored: roster.demoEnabledStored(),
                   propsLeft }))

// ---------- G. S2 end to end: a real Server in its shipped (legacy) mode ----------
await withServer(async () => {
  const rogue = await connectAgent('rogue-1', 'RogueBox')
  const rr = await rogue.ack
  const ci = await Promise.race([rogue.closed, new Promise((r) => setTimeout(() => r(null), 2_000))])
  ok('G1 无凭据的陌生机器：拿到原因后被断开（4001）',
    rr.type === 'rejected' && rr.reason === 'unknown_host' && ci?.code === 4001,
    JSON.stringify({ rr, ci }))
  ok('G1b 被拒的节点没有进名册', !(await get('/api/roster')).nodes.some((n) => n.host_id === 'rogue-1'))

  const noPass = await post('/api/admin/enroll', {})
  ok('G2 签发配对码同样要口令', noPass.status === 403)
  const mint = await post('/api/admin/enroll', { ttl_minutes: 10, max_uses: 2 }, 'another')
  ok('G2b 配对码只在签发响应里出现明文，并带上可粘贴的地址',
    mint.status === 200 && /^[0-9a-f]{12}$/.test(mint.json.code)
    && mint.json.host === '127.0.0.1' && mint.json.agent_port === 9300)

  const ag = await connectAgent('pair-2', 'PairedBox', { token: mint.json.code })
  const ack = await ag.ack
  ok('G3 带配对码注册成功，ack 把节点密钥交回 Agent 落盘',
    ack.type === 'registered' && /^[0-9a-f]{32}$/.test(ack.node_key || ''))
  const r2 = await get('/api/roster')
  const p2 = r2.nodes.find((n) => n.host_id === 'pair-2')
  ok('G3b 配对进来的机器已确认、已带凭据',
    p2?.confirmed === true && p2?.has_credential === true && p2?.presence_class === 'persistent')

  await new Promise((res) => setTimeout(res, 400))
  ag.close()
  await new Promise((res) => setTimeout(res, 400))
  const again = await connectAgent('pair-2', 'PairedBox', { token: ack.node_key })
  const ack2 = await again.ack
  ok('G4 第二次启动凭节点密钥接入，不再消耗配对码',
    ack2.type === 'registered' && !ack2.node_key)
  const codes = await get('/api/enroll')
  const spent = codes.codes.find((c) => c.code_tail === mint.json.code.slice(-4))
  ok('G4b 配对码只花了一次（密钥直连没有重复计数）', spent?.uses === 1, `uses=${spent?.uses}`)
  ok('G5 读接口只回配对码尾号，绝不回明文',
    codes.codes.every((c) => !('code' in c)) && !!spent)
  ok('G5b 未带凭据的 v1 Agent 在页面上可见，不藏在日志里',
    codes.ingest.mode === 'legacy' && codes.ingest.keyless_agents.includes('live-1'),
    JSON.stringify({ mode: codes.ingest.mode, keyless: codes.ingest.keyless_agents }))

  // S2c needs one thing S2a did not provide: revoking a code you can no longer
  // see. The page only ever holds the tail, so the handle has to be the rowid.
  const m3 = await post('/api/admin/enroll', { ttl_minutes: 10, max_uses: 2, note: 'g8' }, 'another')
  const listed = (await get('/api/enroll')).codes.find((c) => c.code_tail === m3.json.code.slice(-4))
  ok('G8 列表给出撤销句柄（id），且仍不含明文',
    listed?.id > 0 && !('code' in listed) && listed.note === 'g8', JSON.stringify(listed))
  ok('G8b 撤销也要口令', (await post('/api/admin/enroll/revoke', { id: listed.id })).status === 403)
  const revoked = await post('/api/admin/enroll/revoke', { id: listed.id }, 'another')
  const after = await connectAgent('g8-box', 'G8Box', { token: m3.json.code })
  const afterAck = await after.ack
  ok('G8c 只凭 id 就能撤销；这枚码之后接入会被拒（unknown_code）',
    revoked.status === 200 && afterAck.type === 'rejected' && afterAck.reason === 'unknown_code'
    && !(await get('/api/roster')).nodes.some((n) => n.host_id === 'g8-box'),
    JSON.stringify({ st: revoked.status, ack: afterAck }))
  ok('G8d 撤销过的码从列表里消失',
    !(await get('/api/enroll')).codes.some((c) => c.id === listed.id))

  const sBefore = await snapshot()
  const on = await post('/api/admin/demo', { enabled: true }, 'another')
  // Past the 3-cycle debounce window: the props must behave like real machines
  // in every other respect, which includes firing their own alerts.
  await new Promise((res) => setTimeout(res, 7_000))
  const sOn = await snapshot()
  const propCount = demoFleet.ids().length   // 同上：台数派生，不抄字面量（H35）
  ok(`G6 演示开关走服务端+口令：${propCount} 台道具上线，卡片数增加（台数从夹具派生）`,
    on.status === 200 && sOn.cluster.demo.total === propCount
    && sOn.hosts.length === sBefore.hosts.length + propCount)
  ok('G6d 道具的告警照常进面板（防抖后），但真机健康度不因此改变',
    sOn.alerts.active.some((a) => a.host_id === 'sim-media' && a.metric === 'disk')
    && sOn.cluster.health === sBefore.cluster.health,
    JSON.stringify({ act: sOn.alerts.active.map((a) => `${a.host_id}/${a.metric}`),
                     h0: sBefore.cluster.health, h1: sOn.cluster.health }))
  const off = await post('/api/admin/demo', { enabled: false }, 'another')
  await new Promise((res) => setTimeout(res, 2_600))
  const sOff = await snapshot()
  ok('G6b 开关切换前后，真实集群的数字一字未动',
    off.status === 200 && sOff.cluster.health === sOn.cluster.health
    && sOff.cluster.total === sOn.cluster.total && sOff.cluster.online === sOn.cluster.online
    && JSON.stringify(sOff.cluster.aggregate) === JSON.stringify(sOn.cluster.aggregate)
    && sOff.cluster.demo.total === 0,
    JSON.stringify({ h: sOff.cluster.health, t: sOff.cluster.total, d: sOff.cluster.demo }))
  ok('G6c 没有口令时连演示开关也 403', (await post('/api/admin/demo', { enabled: true })).status === 403)
  ok('G6e 关演示时它的告警以"已退役"关闭，不会伪装成"已恢复"',
    sOff.alerts.resolved.some((a) => a.host_id === 'sim-media' && a.cancelled === 'retired'),
    JSON.stringify(sOff.alerts.resolved.map((a) => `${a.host_id}/${a.metric}:${a.cancelled}`)))

  {
    /* Last, on purpose: this machine pairs and then leaves, and its OFFLINE
       would otherwise flip cluster.health/online inside the G6 before/after
       comparisons above.
       S2 §5 in reverse: `kind` decides whether a node counts toward the real
       fleet, so the Agent must not get to choose it. A machine that pairs and
       immediately claims to be a demo prop has to land as a normal agent -
       otherwise "关掉演示后数字不变" only holds until someone spoofs a label. */
    const m2 = await post('/api/admin/enroll', { ttl_minutes: 5, max_uses: 1 }, 'another')
    const spoof = await connectAgent('spoof-1', 'SpoofBox',
      { token: m2.json.code, kind: 'demo' })
    const sa = await spoof.ack
    await new Promise((res) => setTimeout(res, 400))
    const r3 = await get('/api/roster')
    const s5 = await snapshot()
    ok('G7 接入帧自报 kind="demo" 无效：真机不能靠贴标签逃出分母与健康度',
      sa.type === 'registered'
      && r3.nodes.find((n) => n.host_id === 'spoof-1')?.kind === 'agent'
      && s5.hosts.find((h) => h.host_id === 'spoof-1')?.kind === 'agent'
      && s5.cluster.total >= 2 && s5.cluster.demo.total === 0,
      JSON.stringify({ ack: sa.type, rkind: r3.nodes.find((n) => n.host_id === 'spoof-1')?.kind,
                       total: s5.cluster.total, demo: s5.cluster.demo }))
    spoof.close()
  }

  again.close()
}, { ...CHILD_ENV, HM_INGEST_TOKEN: 'legacy' })

history.db?.close?.()
metaDb.close()
roster.db?.close?.()   // sections A-D use an in-process Roster on the same file
/* One throwaway dir per run used to pile up (22 by lunchtime on this box). The
   path only earns its keep when something failed, so: clean on green, print
   and keep on red. A handle still closing must not turn a passing run red. */
if (!fail) {
  try { rmSync(DIR, { recursive: true, force: true }) } catch { /* best effort */ }
}
console.log(`\n[selftest-s1] pass=${pass} fail=${fail}${fail ? `   dir kept: ${DIR}` : ''}`)
process.exit(fail ? 1 : 0)
