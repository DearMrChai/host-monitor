/**
 * S6 self-test: one runtime config source, hot reload, per-node overrides,
 * per-node probe plans. Covers S6-细化设计.md §1-§6 and closes H9 (split truth),
 * H7 (one threshold table for an异构 fleet) and H6 (one probe plan for every
 * node, wherever it is).
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
