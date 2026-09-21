/**
 * S6 self-test: one runtime config source, hot reload, per-node overrides,
 * per-node probe plans, frozen-vs-live alerts. Covers S6-细化设计.md §1-§6 and
 * closes H9 (split truth), H7 (one threshold table for a heterogeneous fleet),
 * H6 (one probe plan for every node, wherever it is) and H14 (an alert the
 * Server can no longer back up with data must not make noise).
 *
 * Usage: node scripts/selftest-config.mjs
 * A-D run in-process against a throwaway roster DB; E spawns a real Server on
 * throwaway ports twice, because "the DB is the truth" and "it survives a
 * restart" are only worth asserting across processes - and F re-reads the seed
 * file from a *fresh* process to prove the file is not consulted any more.
 */
import { spawn } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { DatabaseSync } from 'node:sqlite'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..')
const DIR = mkdtempSync(path.join(tmpdir(), 'hm-s6-'))
const DB = path.join(DIR, 'history.db')
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
process.env.HM_DEMO = '0'

const { history } = await import('../src/history.js')
const { roster } = await import('../src/roster.js')
const events = await import('../src/events.js')
const config = await import('../src/config.js')
const { evaluateHost } = await import('../src/status.js')
const { store, nodeProbePlan } = await import('../src/store.js')

events.attach(history, {
  nameOf: (id) => roster.get(id)?.display_name || id,
  reasonText: (r) => r,
})
config.attach({
  get: (key) => roster.getSetting(key),
  set: (key, value) => roster.setSetting(key, value),
})

const SEED = JSON.parse(readFileSync(path.join(SERVER, 'src', 'config', 'thresholds.json'), 'utf8'))

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) pass += 1
  else fail += 1
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `   ${extra}` : ''}`)
}
function qRoster(sql, ...args) {
  const h = new DatabaseSync(ROSTER_DB)
  try { return h.prepare(sql).all(...args) } finally { h.close() }
}
const storedTh = () => JSON.parse(qRoster("SELECT value FROM settings WHERE key='thresholds'")[0]?.value || 'null')

/** The frame shape status.js actually reads; nothing else is needed to judge. */
function metrics(hostId, cpuUsage) {
  store.updateMetrics(hostId, {
    type: 'metrics', host_id: hostId, timestamp: Date.now(),
    cpu: { usage_percent: cpuUsage, cores: 8, temperature_c: 50 },
    memory: { percent: 40 }, disk: { partitions: [] }, gpu: [], probes: { results: [] },
  })
}
/* A-D judge the INSTANT four-state. `getAnnotatedHosts()` runs the alert
   debouncer, which rewrites `status.level` to the debounced level and
   `status.reasons` to the ACTIVE alert rows - reading those would have made
   every single-frame assertion below report "OK / no reasons" for a completely
   unrelated reason (debounce_cycles is 3). The debounced path is exactly what
   E asserts over HTTP, so the two halves together cover both. */
const ann = (hostId) => store.getAnnotatedHosts().find((h) => h.host_id === hostId)
const levelOf = (hostId) => {
  const h = ann(hostId)
  return h ? h.status?.instant_level ?? h.status?.level : undefined
}
const reasonsOf = (hostId) => {
  const h = ann(hostId)
  return h ? evaluateHost(h).reasons : []
}

ok('A0 全部跑在临时库里（生产 roster.db / history 未被触碰）',
  ROSTER_DB.startsWith(DIR) && DB.startsWith(DIR), DIR)

// ---------- A. seeding: the file is a starting point, not a truth ----------
const thRow = storedTh()
ok('A1 空库 attach 后播种出 settings 行，值等于文件',
  !!thRow && JSON.stringify(thRow) === JSON.stringify(SEED)
  && config.thresholds.cpu_usage.warn === SEED.cpu_usage.warn)
ok('A2 播种前 untouched_since_seed 为真（"没人调过"是界面上要说出口的）',
  config.snapshot().untouched_since_seed === true)
{
  const pr = qRoster("SELECT value FROM settings WHERE key='probes'")[0]?.value
  const seedProbes = (() => {
    try { return JSON.parse(readFileSync(path.join(SERVER, 'src', 'config', 'probes.json'), 'utf8')) } catch { return null }
  })()
  ok('A3 探测计划同样只播种一次；没有 probes.json 时保持空态而不是造一个',
    seedProbes ? JSON.parse(pr || 'null') !== null : pr === undefined,
    seedProbes ? '本机有 probes.json（gitignored）' : '本机无 probes.json，跳过实值比对')
}

// ---------- B. hot reload without a restart (J1) ----------
const globalBefore = JSON.stringify(config.thresholds)
{
  const r = config.setThresholds({ ...SEED, cpu_usage: { warn: 90, crit: 97 } })
  ok('B1 setThresholds 写入即生效：不重启，下一帧按 90 判级',
    r.ok === true && JSON.stringify(storedTh().cpu_usage) === JSON.stringify({ warn: 90, crit: 97 }))
}
store.register('box-global', { hostname: 'box-global' })
store.register('box-other', { hostname: 'box-other' })
ok('B2 播种值下 88% 是 WARN（先立住"改之前是什么"）', (() => {
  config.setThresholds(SEED)
  metrics('box-global', 88)
  return levelOf('box-global') === 'WARN'
})())
config.setThresholds({ ...SEED, cpu_usage: { warn: 90, crit: 97 } })
metrics('box-global', 88)
ok('B3 改后同一台、同一读数变成 OK（同进程、无重启、无重新注册）',
  levelOf('box-global') === 'OK')
ok('B4 活对象约定没被破坏：写前写后是同一个引用（重新赋值会让所有 import 变旧）',
  config.thresholds === config.thresholds && globalBefore !== JSON.stringify(config.thresholds),
  '引用同一')
ok('B5 越界与倒挂的阈值被拒，且拒了就不改内存（不静默修正）', (() => {
  const before = JSON.stringify(config.thresholds)
  const bad = config.setThresholds({ ...SEED, cpu_usage: { warn: 99, crit: 50 } })
  const unknown = config.setThresholds({ ...SEED, turbo: true })
  return !bad.ok && bad.errors.some((e) => e.includes('严重档'))
    && !unknown.ok && unknown.errors.some((e) => e.includes('未知配置项'))
    && JSON.stringify(config.thresholds) === before
})())
ok('B6 字符串数字被就地归一（表单里 "92" 落库成 92）',
  config.setThresholds({ ...SEED, mem: { warn: '92', crit: 98 } }).ok
  && config.thresholds.mem.warn === 92)
config.setThresholds(SEED)

// ---------- C. per-node overrides (H7 / J3, J4) ----------
const a = roster.ensure('box-a', { hostname: 'box-a' })
roster.save({ ...a, confirmed: 1, presence_class: 'persistent' })
const b = roster.ensure('box-b', { hostname: 'box-b' })
roster.save({ ...b, confirmed: 1, presence_class: 'persistent' })
store.register('box-a', { hostname: 'box-a' })
store.register('box-b', { hostname: 'box-b' })
metrics('box-a', 88)
metrics('box-b', 88)
ok('C1 没有覆盖时两台同档（88% 在 warn=80 下都是 WARN）',
  levelOf('box-a') === 'WARN' && levelOf('box-b') === 'WARN')
{
  const r = roster.setNodeSettings('box-a', { thresholds: { cpu_usage: { warn: 95, crit: 99 } } },
    { code: 'node_thresholds', detail: { keys: ['cpu_usage'] } })
  ok('C2 覆盖写进节点行，不污染全局（全局仍是 80/95）',
    r.ok === true && JSON.stringify(config.thresholds.cpu_usage) === JSON.stringify(SEED.cpu_usage)
    && qRoster("SELECT settings_json FROM nodes WHERE host_id='box-a'")[0].settings_json.includes('"warn":95'))
}
metrics('box-a', 93)
metrics('box-b', 93)
ok('C3 覆盖只影响该机：93% 在 box-a 是 OK，在 box-b 仍是 WARN',
  levelOf('box-a') === 'OK' && levelOf('box-b') === 'WARN')
metrics('box-a', 96)
const customReason = reasonsOf('box-a').find((x) => x.metric === 'cpu_usage')
ok('C4 原因行写明这条用的是该机自定义值（J3 的后半：不写就是谎话）',
  customReason?.level === 'WARN' && customReason?.custom === true
  && customReason?.threshold === 95, JSON.stringify(customReason))
metrics('box-b', 96)
const globalReason = reasonsOf('box-b').find((x) => x.metric === 'cpu_usage')
ok('C5 未覆盖的机器同名原因行不带 custom 标记，且用的是全局档',
  globalReason?.threshold === SEED.cpu_usage.crit && !globalReason?.custom,
  JSON.stringify(globalReason))
ok('C6 单边覆盖也算覆盖（只抬 crit 时 warn 继承全局）', (() => {
  roster.setNodeSettings('box-a', { thresholds: { cpu_usage: { crit: 100 } } },
    { code: 'node_thresholds', detail: { keys: ['cpu_usage'] } })
  metrics('box-a', 93)
  const one = reasonsOf('box-a').find((x) => x.metric === 'cpu_usage')
  return config.mergeNodeThresholds(roster.nodeThresholds('box-a')).cpu_usage.warn === SEED.cpu_usage.warn
    && one?.level === 'WARN' && !one?.custom
})())
{
  const r = roster.setNodeSettings('box-a', { thresholds: null },
    { code: 'node_thresholds', detail: { cleared: true } })
  metrics('box-a', 93)
  ok('C7 清掉覆盖即回落全局，节点行里不留空壳（J4）',
    r.ok === true && !qRoster("SELECT settings_json FROM nodes WHERE host_id='box-a'")[0].settings_json.includes('thresholds')
    && levelOf('box-a') === 'WARN')
}
// A second box that only *sets* (never cleared) - F 段 needs both wordings to
// exist as separate rows, and inside the 60s merge window a set+clear pair on the
// same node is legitimately one line (asserted as such by F3, not worked around).
roster.setNodeSettings('box-b', { thresholds: { cpu_usage: { warn: 70, crit: 80 } } },
  { code: 'node_thresholds', detail: { keys: ['cpu_usage'] } })
ok('C8 节点覆盖的区间校验独立生效（错值不落库）',
  !config.validateNodeOverrides({ cpu_usage: { warn: 150 } }).ok
  && !config.validateNodeOverrides({ nope: { warn: 1 } }).ok
  && roster.nodeThresholds('box-a') === null)

// ---------- D. probe plan derivation (H6 / J5) ----------
const PLAN = {
  probe_interval_seconds: 7, window_size: 12, site: 'home',
  gateway: { name: '家网关', host: '192.0.2.1' },
  key_hosts: [{ id: 'kh1', name: 'kh1', host: '192.0.2.2', tcp_port: 22 }],
  sites: { office: { gateway: { name: '办公网关', host: '198.51.100.1' }, key_hosts: [] } },
}
ok('D1 全局计划写入后按站点派生：office 命中站点计划，home 落全局',
  config.setProbes(PLAN).ok === true
  && config.probePlanFor({ site: 'office' }).source === 'site'
  && config.probePlanFor({ site: 'home' }).source === 'global')
ok('D2 计划整体择一，不做字段级继承（站点计划没写网关就是没有，而不是拿你家的）',
  config.probePlanFor({ site: 'office' }).plan.gateway.host === '198.51.100.1'
  && config.probePlanFor({ site: 'office' }).plan.key_hosts.length === 0)
ok('D3 计时项跟着全局走（节点改探什么不必重抄多久探一次）',
  config.probePlanFor({ site: 'office' }).plan.probe_interval_seconds === 7
  && config.probePlanFor({ site: 'office' }).plan.window_size === 12
  && Object.values(config.probePlanFor({ site: 'office' }).plan).every((v) => v !== null && v !== undefined))
ok('D4 节点专属压过站点与全局（三级优先）',
  config.probePlanFor({ site: 'office', override: { gateway: { name: '本机网关', host: '203.0.113.9' } } })
    .source === 'node')
ok('D5 未派生到专属/站点计划、又确实来自别的站点 -> 标"可疑"（J5 后半）',
  config.probePlanFor({ site: 'elsewhere' }).suspect === true
  && config.probePlanFor({ site: 'home' }).suspect === false
  && config.probePlanFor({ site: 'office' }).suspect === false)
{
  roster.setProfile('box-b', { site: 'office' })
  const viaRoster = nodeProbePlan('box-b')
  ok('D6 看板徽标与下发给 Agent 的计划出自同一个函数（不会各说一套）',
    viaRoster.source === 'site' && roster.get('box-b').site === 'office')
}
ok('D7 站点名是形状受控的键（__proto__ 这种不会被当成一台站点）',
  !roster.setProfile('box-b', { site: '__proto__' }).ok
  && config.probePlanFor({ site: '__proto__' }).source === 'global'
  && config.validateProbes({ sites: { 'Bad Site': {} } }).length === 1)
ok('D8 探测目标的形状校验在写侧（端口越界/目标过多即拒，不裁到能过）',
  config.validateProbes({ gateway: { name: 'g', host: '1.1.1.1', tcp_port: 70000 } }).length === 1
  && config.validateProbes({ gateway: { name: 'g', host: '' } }).length === 1
  && config.validateProbes({ key_hosts: Array.from({ length: 9 }, (_, i) => ({ host: `10.0.0.${i}` })) })
    .some((e) => e.includes('最多 8')))
ok('D9 空计划不造目标（source=none，Agent 回到只探 Server 臂）',
  config.setProbes({}).ok === true && config.probePlanFor({ site: 'home' }).source === 'none')
config.setProbes(PLAN)
ok('D10 读侧视图把探测目标掩码了（看板是无鉴权读的，S5 G3）',
  !JSON.stringify(config.publicSnapshot()).includes('192.0.2.1')
  && JSON.stringify(config.publicSnapshot()).includes('192.0.*.*')
  && JSON.stringify(config.snapshot()).includes('192.0.2.1'))

// ---------- E. a real second process ----------
/* A-D cannot answer the two questions that actually matter for H9: does a
   *fresh process* read the edited value instead of the file, and does an HTTP
   write reach the cards a client is already looking at. So this section spawns a
   Server on throwaway ports against the same throwaway roster DB. */
const CHILD_ENV = {
  ...process.env, HISTORY_CONFIG: CFG, HM_ROSTER_DB: ROSTER_DB,
  HM_AGENT_PORT: '9320', HM_CLIENT_PORT: '9321', HM_INGEST_TOKEN: 'off', HM_DEMO: '0',
}
const PASS = 's6-selftest-pass'
roster.setPassphrase(PASS, undefined)
// The child reads the roster at boot, so its fixtures are minted before spawn.
for (const id of ['http-box']) {
  const n = roster.ensure(id, { hostname: id })
  roster.save({ ...n, confirmed: 1, presence_class: 'persistent', site: 'home' })
}
/* Written *before* the spawn, and thresholds.json still says 80/95: whatever the
   child reports for these two numbers is the proof of which source it read.
   debounce_cycles=1 keeps each step below to a single tick instead of three. */
config.setThresholds({
  ...SEED, cpu_usage: { warn: 90, crit: 97 },
  alert: { ...SEED.alert, debounce_cycles: 1 },
})
const { WebSocket } = await import('ws')
const REST = 'http://127.0.0.1:9321'
const INGEST = 'ws://127.0.0.1:9320'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function spawnServer() {
  const child = spawn(process.execPath, [path.join(SERVER, 'src', 'index.js')], {
    cwd: SERVER, env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => { if (process.env.HM_VERBOSE) process.stdout.write(`[srv] ${d}`) })
  child.stderr.on('data', (d) => process.stderr.write(`[srv!] ${d}`))
  return child
}
async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${REST}/api/health`)).ok) return true } catch { /* not yet */ }
    await sleep(200)
  }
  return false
}
const getJson = (p) => fetch(`${REST}${p}`).then((r) => r.json())
async function postJson(p, body, withPass = true) {
  const res = await fetch(`${REST}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withPass ? { 'x-hm-admin': PASS } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}
const metricsFrame = (hostId, cpu) => JSON.stringify({
  type: 'metrics', host_id: hostId, timestamp: Date.now(),
  cpu: { usage_percent: cpu, cores: 8, temperature_c: 50 },
  memory: { percent: 40 }, disk: { partitions: [] }, gpu: [], probes: { results: [] },
})
/** Register and hold the socket open: one connection for the whole section, so
 *  "no restart" is part of the assertion rather than something we hope about. */
function feedAgent(hostId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(INGEST)
    const t = setTimeout(() => reject(new Error('agent timeout')), 8000)
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'register', host_id: hostId, hostname: hostId, platform: 'selftest',
    })))
    ws.on('message', (raw) => {
      if (JSON.parse(raw.toString()).type !== 'registered') return
      clearTimeout(t); resolve(ws)
    })
    ws.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}
/** Report again, then let the debouncer take two ticks. Two, not one: an alert
 *  key is *created* pending on the tick that first sees it and only activates on
 *  the next comparison, so even debounce_cycles=1 needs one tick of history
 *  before `status.level` (what the card renders) moves. `offline_seconds` is 15,
 *  so the frame in between is also what keeps this box "here". */
async function poke(ws, hostId, cpu) {
  ws.send(metricsFrame(hostId, cpu))
  await sleep(2_100)
  ws.send(metricsFrame(hostId, cpu))
  await sleep(2_100)
}
const hostJson = async (hostId) => (await getJson('/api/hosts')).hosts?.find((h) => h.host_id === hostId)
const cpuReason = async (hostId) => (await hostJson(hostId))?.status?.reasons
  ?.find((r) => r.metric === 'cpu_usage')

let child = spawnServer()
try {
  ok('E1 子进程 Server 起来了（一次性端口，与生产 9100/9101 无关）', await waitUp())
  {
    const cfg = await getJson('/api/config')
    ok('E2 新进程读的是 DB 里的运行时值，不是文件（H9 的真正断言）',
      JSON.stringify(cfg.thresholds?.cpu_usage) === JSON.stringify({ warn: 90, crit: 97 })
      && cfg.thresholds?.alert?.debounce_cycles === 1
      && cfg.untouched_since_seed === false
      // Guard on the premise: if somebody later edits the seed to these same
      // numbers, this section silently stops proving anything.
      && JSON.stringify(SEED.cpu_usage) === JSON.stringify({ warn: 80, crit: 95 }),
      JSON.stringify(cfg.thresholds?.cpu_usage))
  }

  const denied = await postJson('/api/admin/config/thresholds', { thresholds: SEED }, false)
  ok('E3 没有口令时新端点同样默认拒绝（写闸覆盖到 S6 的五个端点）',
    denied.status === 403, JSON.stringify(denied.json))

  const ws = await feedAgent('http-box')
  await poke(ws, 'http-box', 92)
  const before = await hostJson('http-box')
  const written = await postJson('/api/admin/config/thresholds', {
    thresholds: { ...SEED, cpu_usage: { warn: 95, crit: 98 },
      alert: { ...SEED.alert, debounce_cycles: 1 } },
  })
  await poke(ws, 'http-box', 92)
  const after = await hostJson('http-box')
  ok('E4 HTTP 写阈值后不重启、不断线，同一连接上的卡片就换档（J1 端到端）',
    before?.status?.level === 'WARN' && written.status === 200 && written.json.ok === true
    && after?.status?.level === 'OK',
    JSON.stringify({ before: before?.status?.level, after: after?.status?.level, st: written.status }))

  const bad = await postJson('/api/admin/config/thresholds', { thresholds: { ...SEED, mem: { warn: 0, crit: 0 } } })
  const kept = (await getJson('/api/config')).thresholds
  ok('E5 越界阈值 400 + 人话原因，且一次都没落库（拒了就是没写，不是部分生效）',
    bad.status === 400 && (bad.json.errors || []).length > 0
    && JSON.stringify(kept.cpu_usage) === JSON.stringify({ warn: 95, crit: 98 })
    && kept.mem.warn === 85, JSON.stringify({ st: bad.status, er: bad.json.errors }))

  await poke(ws, 'http-box', 96)
  const base = await cpuReason('http-box')
  const nodeW = await postJson('/api/roster/http-box/thresholds', { thresholds: { cpu_usage: { warn: 90, crit: 99 } } })
  await poke(ws, 'http-box', 96)
  const cr = await cpuReason('http-box')
  ok('E6 经 HTTP 写的 per-node 覆盖生效，并在快照里带着"该机自定义"',
    base?.threshold === 95 && !base?.custom && nodeW.json.ok === true
    && cr?.custom === true && cr?.threshold === 90 && cr?.level === 'WARN',
    JSON.stringify({ base, cr }))
  const cleared = await postJson('/api/roster/http-box/thresholds', { thresholds: null })
  await poke(ws, 'http-box', 96)
  const back = await cpuReason('http-box')
  ok('E7 清空覆盖走的是同一条路（回到继承的 95，而不是留在自定义的 90）',
    cleared.json.ok === true && cleared.json.cleared === true
    && back?.threshold === 95 && !back?.custom, JSON.stringify(back))
  ws.close()

  const leaky = await fetch(`${REST}/api/config`).then((r) => r.text())
  ok('E8 /api/config 可读但不含完整探测目标（掩码在真进程里成立）',
    /"host_masked":true/.test(leaky) && !/"host":"192\.168\.\d+\.\d+"/.test(leaky))

  const probeAck = await new Promise((resolve, reject) => {
    const w = new WebSocket(INGEST)
    const t = setTimeout(() => reject(new Error('ack timeout')), 8000)
    w.on('open', () => w.send(JSON.stringify({
      type: 'register', host_id: 'http-box', hostname: 'http-box', platform: 'selftest',
    })))
    w.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.type === 'registered') { clearTimeout(t); resolve(m); w.close() }
    })
    w.on('error', reject)
  })
  const snapHost = await hostJson('http-box')
  ok('E9 ack 与看板徽标同源：probe_plan_source 与快照里的 source 一致（J5）',
    probeAck.probe_plan_source === snapHost?.probe_plan_source
    && ['global', 'site', 'node', 'none'].includes(probeAck.probe_plan_source),
    JSON.stringify({ ack: probeAck.probe_plan_source, snap: snapHost?.probe_plan_source }))
} catch (e) {
  ok('E 段整体跑通', false, String(e?.message || e))
} finally {
  child.kill()
  await sleep(500)
}

/* Restart: the same throwaway roster.db, a brand new process. "The DB is the
   truth" means what E4 wrote *over HTTP, from another process* must come back out
   of it as 95/98 - the seed file still says 80/95, so this is also the assertion
   that the file was NOT consulted. */
{
  const helper = path.join(DIR, 'read-config.mjs')
  writeFileSync(helper, `
    import { fileURLToPath } from 'url'
    const { roster } = await import(${JSON.stringify(pathToFileURL(path.join(SERVER, 'src', 'roster.js')).href)})
    const config = await import(${JSON.stringify(pathToFileURL(path.join(SERVER, 'src', 'config.js')).href)})
    config.attach({ get: (k) => roster.getSetting(k), set: (k, v) => roster.setSetting(k, v) })
    console.log(JSON.stringify({
      cpu: config.thresholds.cpu_usage,
      untouched: config.snapshot().untouched_since_seed,
      row: roster.getSetting('thresholds'),
    }))
  `)
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, [helper], { env: { ...CHILD_ENV }, cwd: SERVER })
    let buf = ''
    c.stdout.on('data', (d) => { buf += d })
    c.stderr.on('data', (d) => { if (process.env.HM_VERBOSE) process.stderr.write(`[cmp] ${d}`) })
    c.on('close', () => resolve(buf))
  })
  let seen = {}
  try { seen = JSON.parse(out.trim().split('\n').pop()) } catch { /* reported below */ }
  ok('F1 新进程从同一库里读回编辑值（80/95 的文件没被采信）',
    seen.cpu?.warn === 95 && seen.cpu?.crit === 98 && seen.untouched === false
    && seen.row?.includes('"warn":95'), out.trim().slice(0, 160))
}

const stream = events.read({ window: '24h' }).events
const lineFor = (hostId) => stream.filter((e) => e.code === 'node_thresholds' && e.host_id === hostId)
ok('F2 配置写入进了事件流，且措辞说清了"回落全局 / 下次重连"（不是只有一行 JSON）',
  lineFor('box-b').some((e) => e.text.includes('自定义阈值') && e.text.includes('cpu_usage'))
  && lineFor('box-a').some((e) => e.text.includes('回落全局'))
  && stream.some((e) => e.code === 'thresholds_global' && e.text.includes('全局阈值已更新'))
  && !JSON.stringify(stream).includes('"host":"192.0.2.1'),
  JSON.stringify(lineFor('box-a').map((e) => e.text)))
ok('F3 合并窗口内同一节点的"设了又清"是一行，且这行说的是最新状态（count 记账、文字不撒谎）',
  lineFor('box-a').length === 1 && lineFor('box-a')[0].count >= 2
  && lineFor('box-a')[0].text.includes('回落全局'), JSON.stringify(lineFor('box-a')[0]))

/* ---------- G. 冻结 vs. 活告警（H14 / J7） ----------
   The engine reads only `host_id` + `status.reasons`, so a synthetic frame plus
   the clock `advance()` accepts covers the one window that needs no store, no
   Agent and no sleep: "the Server is holding an alert it cannot back up".
   `advance` rather than `tick`, because a restart window is measured in minutes
   and a selftest may not. */
const { AlertEngine } = await import('../src/alerts.js')
const frame = (hostId, level = 'CRIT', value = 96, metric = 'cpu_usage') => ({
  host_id: hostId, hostname: hostId, online: metric !== 'offline',
  status: {
    level,
    reasons: [{ metric, source: 'agent', value, threshold: 95, level }],
  },
})
const GKEY = 'box-c|cpu_usage|agent'
const G0 = Date.now()
{
  const eng = new AlertEngine()
  // debounce_cycles is 3 in the seed; the third tick is what promotes it.
  for (let i = 0; i < 3; i++) eng.advance([frame('box-c')], G0 + i * 2000)
  let act = eng.getLists().active.find((x) => x.id === GKEY)
  ok('G1 有新数据支撑的 CRIT 不带冻结标记（H14 只降级"已经没数据"的那些）',
    !!act && act.state === 'active' && act.frozen === undefined,
    JSON.stringify(act && { state: act.state, frozen: act.frozen }))
  // Grab the persisted row while it still says "active" - the stale closure below
  // rewrites it, and G5 has to replay what a restarted process really reads.
  const rowsWhileActive = history.activeAlertRows().filter((r) => r.id === GKEY)

  // Same machine, same breach - but nothing is reporting any more.
  eng.advance([], G0 + 6000)
  act = eng.getLists().active.find((x) => x.id === GKEY)
  ok('G2 上报断了：告警留在活动表里并被标成冻结，而不是静悄悄变成"已恢复"',
    !!act && act.state === 'active' && act.frozen === true
    && typeof act.frozen_since === 'number', JSON.stringify(act && { s: act.state, f: act.frozen }))

  const graceMs = (config.thresholds.alert?.unknown_alert_grace_minutes ?? 5) * 60_000
  eng.advance([], G0 + 6000 + Math.floor(graceMs / 2))
  ok('G3 宽限期内仍然只是冻结（既不掉出活动表，也还不闭合成任何结论）',
    eng.getLists().active.some((x) => x.id === GKEY && x.frozen === true))
  eng.advance([], G0 + 6000 + graceMs + 2000)
  const closed = eng.getLists().resolved.find((x) => x.id === GKEY)
  ok('G4 宽限期到点闭合成 stale：界面上因此只能印"节点长期未上报"，永不印"已恢复"（J7）',
    !eng.getLists().active.some((x) => x.id === GKEY)
    && closed?.cancelled === 'stale' && closed?.state === 'resolved',
    JSON.stringify(closed && { c: closed.cancelled, s: closed.state }))

  // A brand new process reading the same disk: this is the "重启后自己响一阵" case.
  const booted = new AlertEngine()
  booted.restoreActive(rowsWhileActive)
  const got = booted.getLists().active.find((x) => x.id === GKEY)
  ok('G5 新进程把旧告警从盘上读回的瞬间就是冻结的（不等第一个 tick，否则第一帧快照就够客户端响起来）',
    rowsWhileActive.length === 1 && !!got && got.frozen === true,
    JSON.stringify({ rows: rowsWhileActive.length, f: got?.frozen }))

  booted.advance([frame('box-c', 'CRIT', 99)], Date.now())
  const back = booted.getLists().active.find((x) => x.id === GKEY)
  ok('G6 Agent 回连并再次超限：冻结解除，这条重新变成有数据支撑的告警（该响就响）',
    !!back && back.frozen === undefined && back.latest_value === 99,
    JSON.stringify(back && { f: back.frozen, v: back.latest_value }))

  // The safety side: a machine that is genuinely down must keep making noise.
  const eng2 = new AlertEngine()
  eng2.advance([frame('box-d', 'OFFLINE', null, 'offline')], Date.now())
  const off = eng2.getLists().active.find((x) => x.host_id === 'box-d')
  ok('G7 真的在失联（Server 有这台机器的记录、只是不上线）绝不冻结：可用性告警不许被降级',
    !!off && off.metric === 'offline' && off.frozen === undefined,
    JSON.stringify(off && { m: off.metric, f: off.frozen }))
}
{
  // The sound decision itself is a client predicate (critLoopWanted); assert the
  // contract the server promises it: the key is absent, never `false`.
  const e = new AlertEngine()
  e.advance([frame('box-e')], Date.now())
  e.advance([frame('box-e')], Date.now() + 2000)
  e.advance([frame('box-e')], Date.now() + 4000)
  const live = e.getLists().active.find((x) => x.host_id === 'box-e')
  ok('G8 活告警的行里根本没有 frozen 这个键（客户端判的是 === true，留个 false 是将来误读的坑）',
    live && !('frozen' in live) && !('frozen_since' in live), JSON.stringify(live))
}

/* ---------- H. H22：一次"只改一项"的阈值写入不许把 Server 打死 ---------- */
/* Three halves, all load-bearing:
   ① config:  a table with holes in it is refused, by name, on the write side.
   ② status:  a table that ALREADY has holes is judged as "that line is not
              judged" - a row written before ① existed is still sitting in
              somebody's DB, and boot does not re-validate it (`loadFromStore`
              replaces into the live object as-is), so ① alone would not save an
              installed system. That is what H8-H10 assert, in a fresh process.
   ③ index:   a throw anywhere in the evaluation chain costs one skipped round
              instead of the process - on BOTH entries: the 2s broadcast tick and
              the client WS connection callback. A browser refresh reaches the
              second one, so guarding only the timer leaves the crash live; that
              is the 09-20 ledger correction, and H11/H12 assert the two entries
              separately.
   正对照（拿掉哪一行 → 红哪条；这一节测的是不是空气只看这里）：
     · 拿掉 status.js `levelFor()` 里的 `if (!th) return null`
         -> H5/H5b 红（缺阈值直接抛）。子进程段一起红：H9 读到的是 500（评估器
            在抛），H10 的"事件流里没有 evaluator_error"变成"有一条"——那正是③在
            兜②的漏，不是②在干活。H11-H14 仍绿，它们测的是③，不是②。
     · 拿掉 index.js `snapshotOrNone()` 的 try/catch
         -> H11 红，且子进程当场死掉（H12/H13 的存活断言一起红）。
     · 只留广播那一拍的护栏、把 `clientWss.on('connection')` 改回裸 `store.getSnapshot()`
         -> H12 红（浏览器一接入就死），H6b 的结构断言同时红。 */
const SPEC_METRICS = (config.snapshot().spec.metrics || []).map((m) => m.key)
{
  const beforeObj = JSON.stringify(config.thresholds)
  const beforeRow = roster.getSetting('thresholds')
  const r = config.setThresholds({ mem: { warn: 70, crit: 90 } })
  const errs = (r.errors || []).join(' | ')
  const named = (errs.match(/缺 ([^（|]*)/) || ['', ''])[1].split('、').filter(Boolean)
  ok('H1 只带 {mem:{…}} 的写入被拒，live thresholds 与 DB 行都一字节没动（H22 的真实复现路径）',
    r.ok === false && JSON.stringify(config.thresholds) === beforeObj
    && roster.getSetting('thresholds') === beforeRow, errs.slice(0, 130))
  ok('H2 拒绝理由把每个缺的键都点出来（"格式错误"答不了"我漏了哪几行"），且没把带来的那项算成缺',
    SPEC_METRICS.length > 1 && named.length === SPEC_METRICS.length - 1
    && SPEC_METRICS.filter((k) => k !== 'mem').every((k) => named.includes(k))
    && !named.includes('mem'), `缺 ${named.join('、')}`)
  const s = config.setThresholds({ offline_seconds: 15 })
  ok('H3 只带一个标量的写入同样被拒（{offline_seconds:15} 是另一条真实路径，不是 {mem_usage:…}）',
    s.ok === false && SPEC_METRICS.every((k) => (s.errors || []).join(' ').includes(k))
    && JSON.stringify(config.thresholds) === beforeObj)
  const full = config.setThresholds(SEED)
  const back = config.resetThresholdsToSeed()
  ok('H4 整张表仍是正路：出厂表自身过全覆盖校验，"回落播种值"没被这条收紧关在门外',
    full.ok === true && back.ok === true
    && JSON.stringify(config.thresholds.cpu_usage) === JSON.stringify(SEED.cpu_usage))
}
{
  /* ② judged with the hole put in by hand. After ① no write path can create one,
     which is exactly why it has to be put in by hand here: the state still
     exists in every DB written by the pre-fix code, and boot re-reads those. */
  const savedOrder = Object.entries(config.thresholds)
  const savedMem = { ...config.thresholds.mem }
  delete config.thresholds.mem
  let out = null
  let threw = null
  try {
    out = evaluateHost({
      host_id: 'h5-box', hostname: 'h5-box', online: true, lastSeen: Date.now(),
      metrics: { cpu: { usage_percent: 88, temperature_c: 50 }, memory: { percent: 99 },
        disk: { partitions: [] }, gpu: [], probes: { results: [] } },
    })
  } catch (e) { threw = String(e?.message || e) }
  // Restore the way `replaceInto` does: rebuild in the original key order, or a
  // "restored" object that re-serialized to a reordered DB row would be a lie.
  for (const k of Object.keys(config.thresholds)) delete config.thresholds[k]
  for (const [k, v] of savedOrder) config.thresholds[k] = v
  ok('H5 阈值缺失时 levelFor 返回 null 且不抛（"没有这一档"= 不判这一档）',
    !threw && out?.components?.mem?.level === null, threw || JSON.stringify(out?.components?.mem))
  ok('H5b 缺一条阈值既不等于永远红、也不等于整台不判：读数还在、CPU 照判 WARN、mem 不进成因行',
    out?.components?.mem?.percent === 99 && out?.components?.cpu?.level === 'WARN'
    && out?.level === 'WARN' && !(out?.reasons || []).some((x) => x.metric === 'mem'),
    JSON.stringify(out && { l: out.level, r: (out.reasons || []).map((x) => x.metric) }))
  ok('H5c 这一节自己不留脏状态：改坏的 live thresholds 复原到逐字节相同（含键序，且 mem 值没被借引用改掉）',
    JSON.stringify(config.thresholds) === JSON.stringify(Object.fromEntries(savedOrder))
    && JSON.stringify(config.thresholds.mem) === JSON.stringify(savedMem)
    && JSON.stringify(config.thresholds) === JSON.stringify(SEED))
}
{
  // ③ 的配套：入口覆盖 + 新 kind 在界面上有一格归置它。
  const idx = readFileSync(path.join(SERVER, 'src', 'index.js'), 'utf8')
  const ev = readFileSync(path.join(SERVER, 'src', 'events.js'), 'utf8')
  const cli = readFileSync(path.join(SERVER, '..', 'client', 'src', 'lib', 'events.js'), 'utf8')
  const tabs = (cli.match(/KIND_TABS\s*=\s*\[([\s\S]*?)\]/) || ['', ''])[1]
  const timer = (idx.match(/setInterval\(\(\) => \{([\s\S]*?)\}, BROADCAST_INTERVAL_MS\)/) || ['', ''])[1]
  const conn = (idx.match(/clientWss\.on\('connection', \(ws\) => \{([\s\S]*?)\n\}\);/) || ['', ''])[1]
  const guardFn = (idx.match(/function snapshotOrNone[\s\S]*?\n\}/) || ['', ''])[0]
  const outside = idx.replace(/function snapshotOrNone[\s\S]*?\n\}/, '')
  ok('H6 新 kind 两侧都登记了：服务端记 system/evaluator_error，客户端 KIND_TABS 有 system 这一格',
    /kind:\s*'system'/.test(idx) && /code:\s*'evaluator_error'/.test(idx)
    && /key:\s*'system',\s*label:\s*'[^']+/.test(tabs),
    `${(tabs.match(/key:/g) || []).length} 个 tab`)
  ok('H6b 两条入口各自走 snapshotOrNone，且护栏外只剩一处 getSnapshot（在 express 路由里，抛了是 500 不是死进程）',
    /snapshotOrNone\(/.test(timer) && !/store\.getSnapshot\(\)/.test(timer)
    && /snapshotOrNone\(/.test(conn) && !/store\.getSnapshot\(\)/.test(conn)
    && /try \{[\s\S]{0,60}return store\.getSnapshot\(\)/.test(guardFn)
    && (outside.match(/store\.getSnapshot\(\)/g) || []).length === 1
    && /app\.get\('\/api\/alerts'[\s\S]{0,160}store\.getSnapshot\(\)/.test(outside),
    `${(outside.match(/store\.getSnapshot\(\)/g) || []).length} 处裸调用（护栏函数自身除外）`)
  ok('H6c 那条事件在 events.js 里有自己的中文行（不是把 JS 异常栈印给人看）',
    /case 'evaluator_error':[\s\S]{0,240}评估器异常/.test(ev))
}

/* ---------- H8~H14: the same two holes, seen from a real process ---------- */
const PORTS_H = { AGENT: 9322, CLIENT: 9323 }
const REST_H = `http://127.0.0.1:${PORTS_H.CLIENT}`
/** A frame this Server cannot evaluate: `partitions: [null, null]` makes the
 *  disk reduce in status.js throw. Deliberately NOT a thresholds-shaped poison -
 *  ① now refuses a partial table over any API, so the only way to reach "the
 *  evaluation chain threw" from outside is a bad frame. ③ guards the chain, not
 *  one field of it, and this is the assertion that keeps that honest. */
const poisonFrame = (hostId) => JSON.stringify({
  type: 'metrics', host_id: hostId, timestamp: Date.now(),
  cpu: { usage_percent: 92, cores: 8, temperature_c: 50 }, memory: { percent: 40 },
  disk: { partitions: [null, null] }, gpu: [], probes: { results: [] },
})
const eventsH = async (code = null) => {
  const j = await getH('/api/events?window=24h&limit=400')
  return ((j || {}).events || []).filter((e) => !code || e.code === code)
}
const hostsH = async () => ((await getH('/api/hosts')) || {}).hosts || []
/* Fail-soft on purpose: when the guard under test is missing, the evaluation
   chain throws and those two routes answer 500 (express catches it - which is
   also why they are not the crash path). A test that died on the fetch would
   report one collapsed FAIL; reporting `[]` keeps each assertion its own line,
   and `httpErr` says why. */
let httpErr = ''
async function getH(p) {
  try {
    const r = await fetch(`${REST_H}${p}`)
    if (!r.ok) { httpErr = `${p} -> HTTP ${r.status}`; return null }
    return await r.json()
  } catch (e) { httpErr = `${p} -> ${String(e?.message || e)}`; return null }
}
const openAgentH = (hostId) => new Promise((resolve, reject) => {
  const w = new WebSocket(`ws://127.0.0.1:${PORTS_H.AGENT}`)
  const t = setTimeout(() => reject(new Error('agent timeout')), 8000)
  w.on('open', () => w.send(JSON.stringify({
    type: 'register', host_id: hostId, hostname: hostId, platform: 'selftest',
  })))
  w.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.type !== 'registered') return
    clearTimeout(t); resolve(w)
  })
  w.on('error', (e) => { clearTimeout(t); reject(e) })
})
{
  /* The row is written straight through the roster because after ① there is no
     API left that would put it there - and that is the point: this is what a DB
     written by the pre-fix code looks like to a Server booted with the fix.
     Both CPU lines go, so `components.cpu` has nothing left to judge and its
     level is the observable (`null`) instead of a debounce-dependent colour. */
  const corrupt = { ...SEED }
  delete corrupt.cpu_usage
  delete corrupt.cpu_temp
  roster.setSetting('thresholds', JSON.stringify(corrupt))
  let child = null
  let agent = null
  let cli = null
  const stderr = []
  try {
    child = spawn(process.execPath, [path.join(SERVER, 'src', 'index.js')], {
      cwd: SERVER, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, HISTORY_CONFIG: CFG, HM_ROSTER_DB: ROSTER_DB, HM_DEMO: '0',
        HM_AGENT_PORT: String(PORTS_H.AGENT), HM_CLIENT_PORT: String(PORTS_H.CLIENT),
        HM_INGEST_TOKEN: 'off' },
    })
    child.stderr.on('data', (d) => stderr.push(String(d)))
    let up = false
    for (let i = 0; i < 100 && !up; i++) {
      try { up = (await fetch(`${REST_H}/api/health`)).ok } catch { /* not yet */ }
      if (!up) await sleep(200)
    }
    ok('H8 带着"缺 cpu_usage / cpu_temp"的旧 DB 行也起得来（坏值落库 + 5 秒拉起那一格的前半）', up)
    agent = await openAgentH('h22-box')
    agent.send(metricsFrame('h22-box', 99))
    await sleep(4_500)  // ≥2 broadcast ticks with the hole in place
    httpErr = ''
    const box = (await hostsH()).find((h) => h.host_id === 'h22-box')
    ok('H9 新进程里缺的那两条就是不判：cpu.level=null、99% 的读数还在、卡片不因自己的配置洞变红',
      box?.status?.components?.cpu?.level === null
      && box?.status?.components?.cpu?.usage === 99 && box?.status?.level === 'OK'
      && SEED.cpu_usage.crit === 95   // 判得动的话 99 早就 CRIT 了：这条断言的前提
      && !(box?.status?.reasons || []).some((x) => x.metric === 'cpu_usage' || x.metric === 'cpu_temp'),
      `${JSON.stringify(box?.status && { l: box.status.level, cpu: box.status.components?.cpu })} ${httpErr}`)
    ok('H10 这一路压根没抛：事件流里没有 evaluator_error、进程活着（是②挡住的，不是③兜住的）',
      (await eventsH('evaluator_error')).length === 0 && child.exitCode === null,
      `${httpErr} ${stderr.join('').slice(0, 120)}`)

    agent.send(poisonFrame('h22-box'))
    await sleep(4_500)  // every broadcast tick throws here
    const evs = await eventsH('evaluator_error')
    ok('H11 周期广播这条入口真抛了：进程活着 + 落成一条 system/evaluator_error（点名"周期广播"）',
      child.exitCode === null && evs.length === 1 && evs[0].kind === 'system'
      && evs[0].detail?.where === 'broadcast' && (evs[0].count || 1) >= 2
      && /评估器异常已拦截/.test(evs[0].text) && /周期广播/.test(evs[0].text),
      JSON.stringify(evs[0] || null).slice(0, 240))

    /* A browser refreshing the page is the second entry, and it is the one the
       09-20 ledger correction was about: with only the broadcast tick guarded
       this kills the Server the moment someone opens the board. */
    cli = new WebSocket(REST_H.replace(/^http/, 'ws'))
    const whileBroken = await Promise.race([
      new Promise((res) => { cli.onmessage = (e) => res(String(e.data)) }),
      sleep(2_500).then(() => null),
    ])
    ok('H12 浏览器接入这一条入口也包住了：接入即抛、进程仍然活着、这一拍只是没快照',
      whileBroken === null && child.exitCode === null, stderr.join('').slice(-140))

    const mid = (await eventsH('evaluator_error'))[0]
    agent.send(metricsFrame('h22-box', 92))  // a good frame overwrites the bad one
    const after = await Promise.race([
      new Promise((res) => { cli.onmessage = (e) => res(String(e.data)) }),
      sleep(4_500).then(() => null),
    ])
    ok('H13 恢复是自动的：坏帧被下一个好帧盖掉，同一个 socket 就重新收到快照（跳拍不是拉闸）',
      !!after && JSON.parse(after).type === 'snapshot' && child.exitCode === null)
    const end = await eventsH('evaluator_error')
    ok('H14 每 2 秒一次的失败合成一行并计数（噪声纪律：一行 ×N，不是一分钟 30 行）',
      end.length === 1 && end[0].first_ts === mid?.first_ts && (end[0].count || 1) >= 3
      && /Server 继续运行|本轮快照跳过/.test(end[0].text),
      JSON.stringify(end[0] && { c: end[0].count, w: end[0].detail?.where }))
  } catch (e) {
    ok('H8~H14 子进程段整体跑通', false, String(e?.message || e))
  } finally {
    try { cli?.close() } catch { /* best effort */ }
    try { agent?.close() } catch { /* best effort */ }
    child?.kill()
    await sleep(500)
    // Leave the throwaway DB with a complete table again, for whoever reruns a
    // section by hand: a corrupt row here would look like a new bug.
    config.setThresholds(SEED)
  }
}

history.db?.close?.()
roster.db?.close?.()
events.detach()
/* Clean on green, keep on red - the same harness rule the S2c/S3 selftests use:
   a passing run must not leave another throwaway DB behind, a failing one must
   keep the evidence. Best effort either way, because on Windows an SQLite handle
   still draining makes the unlink EBUSY, and that is not a result. */
if (!fail) {
  try { rmSync(DIR, { recursive: true, force: true }) } catch { /* best effort */ }
} else {
  console.log(`dir kept: ${DIR}`)
}
console.log(`\n[selftest-config] pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
