/**
 * S2b self-test: the REAL Python Agent against a REAL Server.
 * Usage: node server/scripts/selftest-agent-pair.mjs   (throwaway ports 941x)
 *
 * Why this exists instead of more Node-side assertions: everything in
 * selftest-roster.mjs speaks a fake agent written in JavaScript. The whole
 * point of S2b is "a friend runs one command and appears on the board", and
 * that only gets proven by running the actual `python main.py`.
 *
 * Set HM_VERBOSE=1 to see the child Server's log, HM_PYTHON=/path/to/python to
 * pick an interpreter. Exits 0 with a loud SKIP when Python or its deps are
 * missing, so a machine without the agent environment cannot fail CI-style runs.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..')
const AGENT = path.join(SERVER, '..', 'agent')
const MAIN = path.join(AGENT, 'main.py')
const DIR = mkdtempSync(path.join(tmpdir(), 'hm-pair-'))
const DATA = path.join(DIR, 'agent-data')
writeFileSync(path.join(DIR, 'history.json'), JSON.stringify({
  enabled: true, db_path: path.join(DIR, 'history.db'), sample_interval_s: 5,
  raw_retention_days: 7, agg_retention_days: 30, chart_points: 96,
}))

const REST = 'http://127.0.0.1:9411'
const PASS = 'pair-me'
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `   ${extra}` : ''}`)
}

/* ---------- find a usable interpreter, or skip loudly ---------- */
const WIN = process.platform === 'win32'
const q = (s) => (/[\s"^&|<>]/.test(s) ? `"${s}"` : s)
const shellOf = (argv) => argv.map(q).join(' ')

/**
 * Run an interpreter command, tolerating a `.bat` shim.
 * pyenv-win installs `python.bat`, which CreateProcess refuses to exec directly
 * (plain spawn -> ENOENT even though the interpreter is right there), so on
 * Windows a failed plain spawn is retried through the shell. `status === 0`
 * is the only proof: a shell that reports "'py' is not recognized" comes back
 * without an error object but with exit code 1.
 */
function probePy(argv) {
  const direct = spawnSync(argv[0], argv.slice(1), { encoding: 'utf-8' })
  if (!direct.error) return direct
  if (!WIN) return direct
  return spawnSync(shellOf(argv), { encoding: 'utf-8', shell: true })
}

function findPython() {
  const root = process.env.HM_PYTHON ? [process.env.HM_PYTHON] : ['python', 'python3', 'py']
  for (const exe of root) {
    if (probePy([exe, '--version']).status !== 0) continue
    // Resolve to the real .exe and prefer it: `-c` scripts survive a shell only
    // if we quote them ourselves, and every later spawn is simpler without one.
    const resolved = String(probePy([exe, '-c', 'import sys;print(sys.executable)']).stdout || '')
      .trim().split(/\r?\n/).pop()
    const py = existsSync(resolved) ? { file: resolved, shell: false } : { file: exe, shell: WIN }
    const deps = py.shell
      ? spawnSync(shellOf([py.file, '-c', 'import websockets, psutil']), { encoding: 'utf-8', shell: true })
      : spawnSync(py.file, ['-c', 'import websockets, psutil'], { encoding: 'utf-8' })
    if (deps.status === 0) return py
    console.log('\n[pair-selftest] SKIP: ' + py.file + ' 缺 websockets/psutil —— '
      + String(deps.stderr || '').trim().split(/\r?\n/).pop())
    return null
  }
  console.log('\n[pair-selftest] SKIP: 找不到 python（可设 HM_PYTHON=/path/to/python）')
  return null
}
const PY = findPython()
if (!PY) {
  console.log('[pair-selftest] nothing else to assert; the agent side is untested on this machine.')
  process.exit(0)
}
console.log(`[pair-selftest] interpreter: ${PY.file}${PY.shell ? ' (via shell)' : ''}`)

const spawnPy = (args, opts) => (PY.shell
  ? spawn(shellOf([PY.file, ...args]), { ...opts, shell: true })
  : spawn(PY.file, args, opts))
const runPy = (args, opts) => (PY.shell
  ? spawnSync(shellOf([PY.file, ...args]), { ...opts, encoding: 'utf-8', shell: true })
  : spawnSync(PY.file, args, { ...opts, encoding: 'utf-8' }))

const post = async (p, body, admin) => {
  const r = await fetch(`${REST}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(admin ? { 'x-hm-admin': admin } : {}) },
    body: JSON.stringify(body),
  })
  return { status: r.status, json: await r.json().catch(() => null) }
}
const get = async (p) => {
  const r = await fetch(`${REST}${p}`)
  return { status: r.status, json: await r.json().catch(() => null) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Start the agent; `state.done` resolves when its stdout shows `until` (matched),
 *  when it exits (exited) or after timeoutMs. `state.out` keeps everything printed. */
function startAgent(extraArgs, { until = null, timeoutMs = 25_000 } = {}) {
  const args = [MAIN, '--data-dir', DATA, '--interval', '1', ...extraArgs]
  const child = spawnPy(args, {
    cwd: AGENT, env: { ...process.env, PYTHONUNBUFFERED: '1' },
  })
  const state = { child, out: '', err: '', code: null }
  let settle
  state.done = new Promise((r) => { settle = r })
  let settled = false
  const finish = (how) => { if (!settled) { settled = true; settle(how) } }
  child.stdout.on('data', (d) => {
    state.out += d.toString()
    if (until && until.test(state.out)) finish('matched')
  })
  child.stderr.on('data', (d) => { state.err += d.toString() })
  child.on('close', (code) => { state.code = code; finish('exited') })
  setTimeout(() => finish('timeout'), timeoutMs)
  state.stop = (graceMs = 0) => new Promise((r) => {
    let done = false
    const bye = () => { if (!done) { done = true; r() } }
    child.once('close', bye)
    // A refusal exits on its own; killing it instantly would erase the exit code
    // we are about to assert. Give it a grace window, then take it out.
    setTimeout(() => { if (!done) { child.kill(); setTimeout(bye, 3_000) } }, graceMs)
  })
  return state
}

const serverEnv = {
  ...process.env,
  HISTORY_CONFIG: path.join(DIR, 'history.json'),
  HM_ROSTER_DB: path.join(DIR, 'roster.db'),
  HM_AGENT_PORT: '9410', HM_CLIENT_PORT: '9411',
  HM_INGEST_TOKEN: 'legacy',
}

const child = spawn(process.execPath, [path.join(SERVER, 'src', 'index.js')], {
  cwd: SERVER, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (d) => { if (process.env.HM_VERBOSE) process.stdout.write(`[srv] ${d}`) })
child.stderr.on('data', (d) => process.stderr.write(`[srv!] ${d}`))

const killAll = async () => { child.kill(); await sleep(400) }

try {
  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await get('/api/health')).status === 200 } catch { await sleep(200) }
  }
  if (!up) throw new Error('Server did not start on 9411')

  await post('/api/admin/passphrase', { passphrase: PASS })

  // ---------- P1: one command pairs a brand-new machine ----------
  const mint = await post('/api/admin/enroll', { ttl_minutes: 10, max_uses: 2, note: 'pair-selftest' }, PASS)
  const code = mint.json.code
  ok('P0 配对码签发成功', mint.status === 200 && /^[0-9a-f]{12}$/.test(code || ''), `code=…${String(code).slice(-4)}`)

  const a1 = startAgent(['--server', 'ws://127.0.0.1:9410', '--host-id', 'py-1',
    '--role', 'desktop', '--enroll', code], { until: /Paired\. Node key saved/ })
  const m1 = await a1.done
  ok('P1 一条命令：新机器带着配对码就上线了（S2b 的验收原句）', m1 === 'matched',
    m1 === 'matched' ? '' : `结果=${m1} out=${JSON.stringify(a1.out.slice(-260))} err=${JSON.stringify(a1.err.slice(-200))}`)

  let node = null
  for (let i = 0; i < 25 && !node?.has_credential; i++) {
    await sleep(300)
    node = (await get('/api/roster')).json.nodes.find((n) => n.host_id === 'py-1')
  }
  ok('P2 名册里它是已确认、已带凭据的常驻节点', node?.has_credential === true
    && node?.confirmed === true && node?.kind === 'agent', JSON.stringify(node))
  ok('P2b Agent 版本随注册上报并被记住（H2）', node?.agent_version === '1.1.0',
    String(node?.agent_version))

  const identPath = path.join(DATA, 'identity.json')
  const ident = existsSync(identPath) ? JSON.parse(readFileSync(identPath, 'utf-8')) : {}
  ok('P3 节点密钥落在 identity.json，且与 host_id 绑在一起',
    /^[0-9a-f]{32}$/.test(ident.node_key || '') && ident.host_id === 'py-1'
    && ident.server === 'ws://127.0.0.1:9410', JSON.stringify({ k: ident.node_key?.slice(0, 6) + '…', id: ident.host_id }))
  ok('P3b 密钥没有混进 agent.json（那份文件是要贴给朋友看的）',
    !existsSync(path.join(DATA, 'agent.json'))
    || !readFileSync(path.join(DATA, 'agent.json'), 'utf-8').includes(ident.node_key))

  const hosts = (await get('/api/hosts')).json
  const snap = JSON.stringify(await get('/api/roster').json) + JSON.stringify(hosts)
    + JSON.stringify((await get('/api/enroll')).json)
  ok('P4 任何读接口都拿不到明文密钥', !snap.includes(ident.node_key || '@@none@@'))

  // A roster entry appears with the register frame; the first metrics frame
  // lands up to an interval later. Poll rather than assume they are atomic.
  let live = null
  for (let i = 0; i < 20 && typeof live?.metrics?.cpu?.usage_percent !== 'number'; i++) {
    await sleep(300)
    live = (await get('/api/hosts')).json.hosts.find((h) => h.host_id === 'py-1')
  }
  ok('P4b 看板上有它的实时数据（不只是一个名册条目）',
    !!live && live.online === true && typeof live.metrics?.cpu?.usage_percent === 'number'
    && Array.isArray(live.metrics?.disk?.partitions) && live.metrics?.cpu?.cores > 0,
    live ? `${live.display_name || live.hostname} cpu=${live.metrics?.cpu?.usage_percent} `
      + `cores=${live.metrics?.cpu?.cores} disk=${live.metrics?.disk?.partitions?.length} `
      + `probe=${!!live.metrics?.probes}` : 'missing')

  await a1.stop()
  await sleep(1_200)

  // ---------- P5: the second start needs no code ----------
  const before = (await get('/api/enroll')).json.codes.find((c) => c.code_tail === code.slice(-4))
  const a2 = startAgent(['--server', 'ws://127.0.0.1:9410', '--host-id', 'py-1'],
    { until: /Credential: identity/ })
  const m2 = await a2.done
  let back = null
  for (let i = 0; i < 20 && !back?.online; i++) {
    await sleep(400)
    back = (await get('/api/hosts')).json.hosts.find((h) => h.host_id === 'py-1')
  }
  const after = (await get('/api/enroll')).json.codes.find((c) => c.code_tail === code.slice(-4))
  ok('P5 第二次启动不再要配对码，凭本机身份直连', m2 === 'matched'
    && /Credential: identity\.json/.test(a2.out) && back?.online === true,
    a2.out.split(/\r?\n/).find((l) => /Credential/.test(l)) || a2.out.slice(-120))
  ok('P5b 它没有消耗配对码（用的就是长期密钥）',
    after?.uses === before?.uses, `uses ${before?.uses} -> ${after?.uses}`)
  await a2.stop()

  // ---------- P6: a wrong code says so, and says so usefully ----------
  const bad = startAgent(['--server', 'ws://127.0.0.1:9410', '--host-id', 'py-typo',
    '--enroll', '000000000000'], { until: /拒绝接入/, timeoutMs: 15_000 })
  const mb = await bad.done
  await bad.stop(4_000)
  ok('P6 抄错/不存在的配对码：机器被拒并给出人话，而不是无限重试',
    mb === 'matched' && /配对码不存在/.test(bad.out) && bad.code === 2,
    JSON.stringify({ m: mb, code: bad.code, line: bad.out.split(/\r?\n/).find((l) => /拒绝接入/.test(l)) || '' }))
  const roster3 = (await get('/api/roster')).json.nodes
  ok('P6b 被拒的机器没有进名册', !roster3.some((n) => n.host_id === 'py-typo'))

  // ---------- P7: an unpaired machine cannot just join ----------
  const free = startAgent(['--server', 'ws://127.0.0.1:9410', '--host-id', 'py-free'],
    { until: /拒绝接入/, timeoutMs: 15_000 })
  const mf = await free.done
  await free.stop(4_000)
  ok('P7 没有凭据的陌生机器（legacy 默认档）：被拒 + 中文原因 + 退出码非 0',
    mf === 'matched' && /服务器不认识这台机器/.test(free.out) && free.code === 2
    && !/Retrying/.test(free.out),
    JSON.stringify({ m: mf, code: free.code }))

  // ---------- P8: --print-config answers "which file am I reading" ----------
  const pc = runPy([MAIN, '--data-dir', DATA, '--print-config'],
    { cwd: AGENT, timeout: 20_000 })
  ok('P8 --print-config 说清每项来源（远程排障第一问）',
    pc.status === 0 && /from identity\.json/.test(pc.stdout) && /py-1/.test(pc.stdout),
    (pc.stdout || '').split(/\r?\n/).filter((l) => /=/.test(l)).join(' | ').slice(0, 220))
} finally {
  await killAll()
}

// Same rule as the roster suite: clean on green, keep and print on red.
if (!fail) {
  try { rmSync(DIR, { recursive: true, force: true }) } catch { /* best effort */ }
}
console.log(`\n[pair-selftest] pass=${pass} fail=${fail}${fail ? `   dir kept: ${DIR}` : ''}`)
process.exit(fail ? 1 : 0)
