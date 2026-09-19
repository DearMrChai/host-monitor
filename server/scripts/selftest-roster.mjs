/**
 * S1 self-test: roster + presence semantics + mute + admin passphrase, end to end.
 * Usage: node scripts/selftest-roster.mjs     (spins its own Server on 93xx)
 *
 * Covers S1-细化设计.md §8 items 1-6. Everything runs against throwaway DB files
 * in the system temp dir, so the dev/production data dir is never touched.
 * Set HM_VERBOSE=1 to see the child Server's stdout.
 */
import { writeFileSync, mkdtempSync } from 'fs'
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

ok('A12 publicOf 不泄漏 enroll_token / fingerprint', (() => {
  roster.ensure('sec-1', { hostname: 'sec', token: 'tok-secret', fingerprint: 'fp-secret' })
  const pub = JSON.stringify(roster.publicOf('sec-1'))
  return !pub.includes('tok-secret') && !pub.includes('fp-secret')
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
const metaRows = new DatabaseSync(ROSTER_DB).prepare('SELECT value FROM meta').all()
ok('D7 口令以 scrypt 散列入库，明文不落盘',
  metaRows.every((r) => String(r.value).startsWith('scrypt$'))
  && !JSON.stringify(metaRows).includes('another'),
  String(metaRows[0]?.value).slice(0, 20) + '…')

// ---------- E. end to end against a real Server on throwaway ports ----------
const CHILD_ENV = {
  ...process.env,
  HISTORY_CONFIG: CFG, HM_ROSTER_DB: ROSTER_DB,
  HM_AGENT_PORT: '9300', HM_CLIENT_PORT: '9301',
}
const { WebSocket } = await import('ws')
const REST = 'http://127.0.0.1:9301'
const INGEST = 'ws://127.0.0.1:9300'

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
    && l1.display_name === 'LiveBox',
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

  const c = await connectAgent('live-1', 'LAPTOP-RENAMED-BY-OS')
  const row = (await snapshot()).hosts.find((h) => h.host_id === 'live-1')
  ok('E10 重连后仍用名册显示名（系统主机名变化不覆盖用户改名）',
    row?.display_name === '我的游戏本', row?.display_name)
  c.close()
})

history.db?.close?.()
console.log(`\n[selftest-s1] pass=${pass} fail=${fail}   dir=${DIR}`)
process.exit(fail ? 1 : 0)
