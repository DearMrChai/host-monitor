/**
 * S5 credential-hygiene self-test — the gate before observed (S5-细化设计.md §0).
 * Usage: node scripts/selftest-credential-hygiene.mjs
 *
 * G1  a stolen roster.db yields no usable credential (node keys hashed, and the
 *     pre-S5 plaintext rows are hashed *and* the stale pages vacuumed away)
 * G2  every mutating route is behind requireAdmin, enumerated from the real
 *     Express route table — a future endpoint that forgets the gate turns red
 * G3  no read endpoint, log line or event row carries a passphrase, a node key,
 *     a pairing code, a full fingerprint or a full peer address
 * G4  (read side) the presence ledger cannot reach the four-state path
 *
 * Unlike the other self-tests this one imports `src/index.js` **in process**:
 * the route table is only checkable from the object Express built, and the leak
 * scan is worth more when it reads the endpoints a real Server actually answers.
 * Throwaway ports + throwaway DB files, so a live Server on 9100/9101 is
 * untouched. Set HM_VERBOSE=1 for the child processes' stdout.
 */
import { writeFileSync, readdirSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import { DatabaseSync } from 'node:sqlite'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..')
const DIR = mkdtempSync(path.join(tmpdir(), 'hm-s5-'))
const LEGACY_DIR = path.join(DIR, 'legacy')

const HISTORY_DB = path.join(DIR, 'history.db')
const ROSTER_DB = path.join(DIR, 'roster.db')
const CFG = path.join(DIR, 'history.json')
writeFileSync(CFG, JSON.stringify({
  enabled: true, db_path: HISTORY_DB, sample_interval_s: 5,
  raw_retention_days: 7, agg_retention_days: 30, chart_points: 96,
}))
process.env.HISTORY_CONFIG = CFG
process.env.HM_ROSTER_DB = ROSTER_DB
// strict, because G1/G3 only mean something on the mode production runs.
process.env.HM_INGEST_TOKEN = 'strict'
const AGENT_PORT = 9410
const CLIENT_PORT = 9411
process.env.HM_AGENT_PORT = String(AGENT_PORT)
process.env.HM_CLIENT_PORT = String(CLIENT_PORT)

// Secrets this file invents, then hunts for everywhere they must not appear.
const PASS = 'hygiene-passphrase-1'
const PASS_BAD = 'hygiene-passphrase-WRONG'
const FP = 'fingerprint-aabbccddeeff0011'
const LEGACY_KEY = 'a'.repeat(32)

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `   ${extra}` : ''}`)
}

/** Everything SQLite may have written for one logical DB: main + -wal + -shm.
 *  latin1 keeps ASCII bytes intact, so an ASCII secret is findable whichever
 *  page it is sleeping in. G1 is a claim about the *disk*, not about SELECTs. */
function dbBytes(dir, base) {
  let all = ''
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(base)) continue
    try { all += readFileSync(path.join(dir, f)).toString('latin1') } catch { /* locked */ }
  }
  return all
}

const { history } = await import('../src/history.js')
const { roster } = await import('../src/roster.js')

// ---------- A. G1: node keys land hashed ----------
roster.ensure('hyg-box', { hostname: 'HygBox', role: 'server', node_key: LEGACY_KEY, fingerprint: FP })
const storedKey = roster.get('hyg-box').enroll_token
ok('A1 配对写入的节点密钥是 sha256$<salt>$<hash> 形态，库里没有明文',
  String(storedKey).startsWith('sha256$') && storedKey.split('$')[2].length === 64
  && !String(storedKey).includes(LEGACY_KEY), String(storedKey).slice(0, 16) + '…')
ok('A2 正确密钥通过、错误/空/非字符串一律拒绝',
  roster.keyMatches('hyg-box', LEGACY_KEY)
  && roster.keyMatches('hyg-box', 'b'.repeat(32)) === false
  && roster.keyMatches('hyg-box', '') === false
  && roster.keyMatches('hyg-box', null) === false
  && roster.keyMatches('no-such-node', LEGACY_KEY) === false)
ok('A3 每次哈希带不同 salt：同一密钥两次落库形态不同', (() => {
  roster.ensure('hyg-salt', { hostname: 'SaltBox', node_key: LEGACY_KEY })
  const a = roster.get('hyg-salt').enroll_token
  const b = roster.get('hyg-box').enroll_token
  return a !== b && a.split('$')[2] !== b.split('$')[2]
})())
ok('A4 publicOf/nodeKeyOf 都不给出可用凭据', (() => {
  const pub = JSON.stringify(roster.publicOf('hyg-box'))
  return !pub.includes(LEGACY_KEY) && !pub.includes(FP) && pub.includes('"has_credential":true')
    && !JSON.stringify(roster.nodeKeyOf('hyg-box')).includes(LEGACY_KEY)
})())
ok('A5 静态盘上没有那把明文密钥（含 -wal/-shm）',
  !dbBytes(DIR, 'roster.db').includes(LEGACY_KEY))

/* ---------- B. G1 for a pre-S5 DB: plaintext rows must be swept, and the
   * freed pages that still hold them must be rewritten.
   * A separate process, because Roster is a singleton and the sweep runs in its
   * constructor — which is exactly where a production boot does it too. ------ */
{
  mkdirSync(LEGACY_DIR, { recursive: true })
  const legacyDb = path.join(LEGACY_DIR, 'roster.db')
  const ld = new DatabaseSync(legacyDb)
  ld.exec(`CREATE TABLE nodes (host_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
    hostname TEXT, role TEXT, owner TEXT NOT NULL DEFAULT 'me', site TEXT NOT NULL DEFAULT 'home',
    kind TEXT NOT NULL DEFAULT 'agent', presence_class TEXT NOT NULL DEFAULT 'persistent',
    confirmed INTEGER NOT NULL DEFAULT 0, enrolled_at INTEGER, last_seen INTEGER,
    agent_version TEXT, enroll_token TEXT, fingerprint TEXT, settings_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE enroll_codes (code TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
      note TEXT, paired_ids TEXT NOT NULL DEFAULT '');`)
  ld.prepare(`INSERT INTO nodes (host_id, display_name, hostname, enroll_token, confirmed)
    VALUES ('old-agent','OldAgent','OldAgent',?,1)`).run(LEGACY_KEY)
  ld.close()

  const child = path.join(DIR, 'legacy-child.mjs')
  writeFileSync(child, `
    const { roster } = await import(${JSON.stringify(pathToFileURL(path.join(SERVER, 'src', 'roster.js')).href)})
    console.log('RESULT ' + JSON.stringify({
      stored: roster.nodeKeyOf('old-agent'),
      matches: roster.keyMatches('old-agent', ${JSON.stringify(LEGACY_KEY)}),
      wrong: roster.keyMatches('old-agent', 'c'.repeat(32)),
    }))
  `)
  const out = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [child], {
      cwd: SERVER, env: { ...process.env, HM_ROSTER_DB: legacyDb },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buf = ''
    c.stdout.on('data', (d) => {
      buf += d
      if (process.env.HM_VERBOSE) process.stdout.write(`[ch] ${d}`)
    })
    c.stderr.on('data', (d) => process.stderr.write(`[ch!] ${d}`))
    c.on('error', reject)
    c.on('exit', () => resolve(buf))
  })
  const line = out.split('\n').find((l) => l.startsWith('RESULT '))
  const r = line ? JSON.parse(line.slice(7)) : {}
  ok('B1 明文老库启动后被就地哈希，Agent 侧不需要重新配对',
    String(r.stored).startsWith('sha256$') && !String(r.stored).includes(LEGACY_KEY)
    && r.matches === true && r.wrong === false, line || out.slice(0, 120))
  ok('B2 迁移后静态盘读不到那把明文密钥（检查点+VACUUM 生效）',
    !dbBytes(LEGACY_DIR, 'roster.db').includes(LEGACY_KEY),
    readdirSync(LEGACY_DIR).join(' '))
}

// ---------- C. G2: the real route table ----------
const { app, _adminFails } = await import('../src/index.js')
{
  /* One whitelist entry, with its reason: on a fresh install there is no
     passphrase to present yet, so the endpoint that sets one cannot sit behind
     its own gate. It is still guarded (setPassphrase demands the old value as
     soon as one exists) and it pays for the same scrypt, so it shares the
     failure budget. Anything else that lands here is drift. */
  const WHITELIST = new Map([
    ['/api/admin/passphrase', '首个口令无法自证；已设口令时改口令必须带原口令（S5 §3.1）'],
  ])
  const routes = []
  for (const layer of app._router?.stack || []) {
    if (!layer.route) continue
    routes.push({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).map((m) => m.toUpperCase()),
      gated: layer.route.stack.some((l) => l.handle?.name === 'requireAdmin'),
    })
  }
  const writes = routes.filter((r) => r.methods.some((m) => m !== 'GET' && m !== 'HEAD'))
  const ungated = writes.filter((r) => !r.gated && !WHITELIST.has(r.path))
  ok('C1 每个非 GET 路由的中间件链里都有 requireAdmin（白名单外零例外）',
    writes.length > 0 && ungated.length === 0,
    JSON.stringify({ writes: writes.length, ungated: ungated.map((r) => r.path) }))
  const seen = writes.map((r) => r.path).sort()
  const expected = [
    '/api/admin/demo', '/api/admin/enroll', '/api/admin/enroll/revoke',
    '/api/admin/passphrase', '/api/presence/alias',
    '/api/roster/:hostId/class', '/api/roster/:hostId/mute', '/api/roster/:hostId/name',
    // S6 §5: the settings screen's five writes. They are listed here because
    // listing them is what turns "somebody added an endpoint" into a decision
    // rather than an accident - C1 above already proved each one is gated.
    '/api/admin/config/thresholds', '/api/admin/config/probes',
    '/api/roster/:hostId/settings', '/api/roster/:hostId/thresholds',
    '/api/roster/:hostId/probes',
  ].sort()
  ok('C2 写端点集合与文档一致（新增了端点就先补断言，别让它在盲区里长大）',
    JSON.stringify(seen) === JSON.stringify(expected),
    JSON.stringify({ only_seen: seen.filter((p) => !expected.includes(p)),
                     only_expected: expected.filter((p) => !seen.includes(p)) }))
  const reads = routes.filter((r) => r.methods.every((m) => m === 'GET' || m === 'HEAD'))
  ok('C3 读侧仍然开放（形态 A 的展示用途），且数量符合预期',
    reads.length >= 8, reads.map((r) => r.path).join(' '))
  /* Identity, not name: every gated route must hold the *same* function object,
     so a second copy of the gate — one that forgot the failure budget or the
     default-deny — cannot quietly appear next to the real one. */
  const gates = new Set()
  for (const layer of app._router.stack) {
    if (!layer.route) continue
    for (const l of layer.route.stack) if (l.handle?.name === 'requireAdmin') gates.add(l.handle)
  }
  ok('C4 口令闸门在进程里只有一个实现（不是同名包装，逻辑不会分叉）',
    gates.size === 1 && writes.filter((r) => r.gated).length === writes.length - WHITELIST.size,
    `gates=${gates.size} writes=${writes.length}`)
}

// ---------- D. G3: real Server, real Agent, then read everything back ----------
const REST = `http://127.0.0.1:${CLIENT_PORT}`
const INGEST = `ws://127.0.0.1:${AGENT_PORT}`
const { WebSocket } = await import('ws')

const get = async (p) => {
  const res = await fetch(`${REST}${p}`)
  const text = await res.text()
  return { status: res.status, text, json: () => { try { return JSON.parse(text) } catch { return {} } } }
}
const post = async (p, body, admin) => {
  const res = await fetch(`${REST}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(admin ? { 'x-hm-admin': admin } : {}) },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, text, json: () => { try { return JSON.parse(text) } catch { return {} } } }
}

/** Register over the ingest socket and hand back whatever the ack carried. */
function connectAgent(hostId, hostname, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(INGEST)
    let settled = false
    const ack = new Promise((r) => { ws.ackThen = r })
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if ((m.type === 'registered' || m.type === 'rejected') && !settled) {
        settled = true
        ws.ackThen(m)
      }
    })
    ws.on('close', () => { if (!settled) { settled = true; ws.ackThen({ type: 'closed' }) } })
    ws.ack = ack
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'register', host_id: hostId, hostname, platform: 'linux', role: 'server', ...extra,
      }))
      resolve(ws)
    })
    ws.on('error', reject)
  })
}

async function waitUp() {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${REST}/api/health`)).ok) return true } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Server did not come up on ${CLIENT_PORT}`)
}

await waitUp()

let nodeKey = null
let codePlain = null
{
  const first = await post('/api/roster/hyg-box/name', { name: '改名不该成功' })
  ok('D1 未设口令时写侧默认拒绝（403，不是 401 也不是放行）',
    first.status === 403 && JSON.stringify(first.json()).includes('未设置管理口令'), first.text.slice(0, 80))

  ok('D2 设口令的响应里没有口令本身',
    (await post('/api/admin/passphrase', { passphrase: PASS })).text === '{"ok":true}')
  ok('D3 口令以 scrypt 入库，静态盘上没有明文（G1 的另一半）',
    roster.hasPassphrase() && !dbBytes(DIR, 'roster.db').includes(PASS))
  ok('D4 错口令 403、对口令放行',
    (await post('/api/roster/hyg-box/name', { name: 'x' }, PASS_BAD)).status === 403
    && (await post('/api/roster/hyg-box/name', { name: '值守机' }, PASS)).status === 200)

  const mint = await post('/api/admin/enroll', { ttl_minutes: 5, max_uses: 2 }, PASS)
  codePlain = mint.json().code
  const paired = await connectAgent('hyg-box', 'HygBox', { token: codePlain, fingerprint: FP })
  const ack = await paired.ack
  nodeKey = ack.node_key
  ok('D5 strict 下配对码换到节点密钥（密钥只在 ack 里出现一次）',
    ack.type === 'registered' && typeof nodeKey === 'string' && nodeKey.length === 32, ack.type)
  paired.send(JSON.stringify({
    type: 'metrics', host_id: 'hyg-box', hostname: 'HygBox',
    cpu: { usage_percent: 22, temp_c: 55 }, mem: { percent: 41 },
    disk: { mounts: [{ mount: '/', percent: 62 }] },
  }))
  await new Promise((r) => setTimeout(r, 300))

  const denied = await connectAgent('ghost-box', 'Ghost', {})
  const dAck = await denied.ack
  ok('D6 strict 下无名册无凭据的连接被拒（H8 的性质），且拒绝理由不含凭据',
    dAck.type === 'rejected' && dAck.reason === 'unknown_host'
    && !JSON.stringify(dAck).includes(codePlain), JSON.stringify(dAck))

  const second = await post('/api/admin/enroll', { ttl_minutes: 3, max_uses: 1 }, PASS)
  const listed = (await get('/api/enroll')).json()
  ok('D7 配对页只给出码尾，未过期的码不再回明文（明文一生只显示一次）',
    second.status === 200
    && listed.codes.some((c) => c.code_tail && !JSON.stringify(c).includes(codePlain))
    && !JSON.stringify(listed).includes(codePlain) && !JSON.stringify(listed).includes(nodeKey))

  const secrets = [
    ['管理口令', PASS], ['节点密钥', nodeKey], ['配对码明文', codePlain],
    ['机器指纹全值', FP], ['哈希形态标记', 'sha256$'], ['口令哈希形态', 'scrypt$'],
  ]
  const READS = ['/api/hosts', '/api/alerts', '/api/alerts/history?limit=50',
    '/api/events?window=24h', '/api/events?window=2h&limit=5', '/api/health',
    '/api/roster', '/api/enroll', '/api/presence', '/api/history/hyg-box?range=2h',
    // S6: the settings screen reads config without a passphrase, so its masking
    // is covered by the same "no full IPv4" rule as everything else.
    '/api/config']
  /* One line per endpoint, and the extra names the specific secret that leaked,
     so a failure reads as "which credential, which endpoint" rather than 60
     red rows. The scan covers the body a *client* can fetch without any
     passphrase — that is the definition of G3. */
  const bodies = []
  for (const p of READS) {
    const r = await get(p)
    bodies.push({ p, text: r.text, status: r.status })
    const leaked = secrets.filter(([, needle]) => needle && r.text.includes(needle)).map(([w]) => w)
    const ip = r.text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
    ok(`D8 ${p}：200 且响应体不含口令/节点密钥/配对码/完整指纹/完整对端地址`,
      r.status === 200 && leaked.length === 0 && !ip,
      JSON.stringify({ st: r.status, leaked, ip: ip?.[0] || null }))
  }
  const ev = (await get('/api/events?window=2h')).json()
  const refusal = ev.events?.find((e) => e.detail?.addr)
  /* The mask is /16 (`127.0.*.*`), which on a home LAN collapses every box into
     one row. That is the trade S2 §3 already made, and `host_id` on the same row
     is what actually answers "who got turned away". Asserting the exact shape
     keeps this honest if the mask is ever loosened. */
  ok('D9 事件行里的对端地址是掩码，被拒记录仍然答得出是谁被拒',
    !!refusal && refusal.detail.addr === '127.0.*.*',
    JSON.stringify(refusal?.detail || ev.events?.slice(0, 2)))
  const snap = (await get('/api/hosts')).json()
  ok('D10 快照里没有 ZT/presence 字段（G4：在场台账进不了四态）',
    !JSON.stringify(snap).toLowerCase().includes('zt_addr')
    && !JSON.stringify(snap).toLowerCase().includes('presence_state')
    && snap.hosts?.some((h) => h.host_id === 'hyg-box'))
  paired.close()
  denied.close()
}

// ---------- E. G4's structural half: no import edge ----------
{
  const src = (f) => readFileSync(path.join(SERVER, 'src', f), 'utf8')
  const edge = ['store.js', 'status.js', 'alerts.js', 'demo.js'].filter(
    (f) => /from ['"][^'"]*zerotier/.test(src(f)))
  ok('E1 四态链路上的模块一个都没有 import zerotier.js（不是"我们约定"，是引用边为零）',
    edge.length === 0, edge.join(' '))
  ok('E2 zerotier.js 只 import 名册，不 import store/status/alerts/history',
    !/\bfrom ['"]\.\/(store|status|alerts|history)/.test(src('zerotier.js'))
    && /from ['"]\.\/roster\.js['"]/.test(src('zerotier.js')))
  /* J2 (H9) decided with a grep, not with a convention: a second reader of the
     seed files is invisible at runtime (it agrees with the DB until somebody
     edits the DB), so the only affordable check is the static one. Matched on
     the *call*, not the filename: the design notes name these files in prose,
     and a scan that goes red on a comment gets ignored within a week. */
  const files = readdirSync(path.join(SERVER, 'src')).filter((f) => f.endsWith('.js'))
  const readsSeed = /readFileSync\([\s\S]{0,120}?(thresholds|probes)\.json/
  const fileReaders = files.filter((f) => f !== 'config.js' && readsSeed.test(src(f)))
  ok('E3 只有 config.js 会读 thresholds.json / probes.json（其余模块一律走运行时真源）',
    fileReaders.length === 0, fileReaders.join(' '))
  ok('E4 config.js 不 import 本项目任何模块（持久化靠 attach 注入），且 status.js 不再转出口阈值',
    !/from ['"]\.\/(store|status|alerts|history|roster|ingest|demo|zerotier|events)/.test(src('config.js'))
    && !/export const thresholds/.test(src('status.js')),
    '引用边应为零')
}

// ---------- F. G2's cost side: the scrypt failure budget ----------
{
  const real = roster.checkPassphrase.bind(roster)
  let calls = 0
  roster.checkPassphrase = (p) => { calls += 1; return real(p) }
  _adminFails.clear()
  const statuses = []
  for (let i = 0; i < 9; i++) {
    statuses.push((await post('/api/roster/hyg-box/name', { name: '猜一次' }, PASS_BAD)).status)
  }
  ok('F1 连打 9 次错口令：前 8 次 403，第 9 次 429',
    statuses.slice(0, 8).every((s) => s === 403) && statuses[8] === 429,
    statuses.join(','))
  ok('F2 预算之后不再进 scrypt（CPU 自伤面被关掉：8 次哈希，不是 9 次）',
    calls === 8, `checkPassphrase called ${calls}x`)
  const body = (await post('/api/roster/hyg-box/name', { name: 'x' }, PASS_BAD)).json()
  ok('F3 429 不回"还差几次"，也不回任何数字',
    body.error === '口令尝试过于频繁，请稍后再试' && !/\d/.test(JSON.stringify(body)))
  ok('F4 白名单端点共用同一份预算（设口令也要付 scrypt 的钱）',
    (await post('/api/admin/passphrase', { passphrase: 'another-one-entirely' })).status === 429)
  _adminFails.clear()
  const back = await post('/api/roster/hyg-box/name', { name: '值守机' }, PASS)
  ok('F5 预算窗口过后正常放行，且成功会把该地址的失败计数清零',
    back.status === 200 && _adminFails.size === 0, `HTTP ${back.status}`)
  roster.checkPassphrase = real
}

// ---------- G. enroll_codes dead rows (S5 §5.2) ----------
{
  const now = Date.now()
  const ins = roster.db.prepare(`INSERT INTO enroll_codes
    (code, created_at, expires_at, max_uses, uses, note, paired_ids) VALUES (?,?,?,?,?,'','')`)
  ins.run('dead00000001', now - 46 * 86_400_000, now - 31 * 86_400_000, 1, 1)
  ins.run('old000000002', now - 40 * 86_400_000, now - 29 * 86_400_000, 1, 1)
  const before = roster.db.prepare('SELECT COUNT(*) c FROM enroll_codes').get().c
  history.rollAndCleanup()
  const left = roster.db.prepare('SELECT code FROM enroll_codes').all().map((r) => r.code)
  ok('G1 过期 31 天的码行被清，29 天的与未到期的留下（挂在同一把 retention 时钟上）',
    before >= 4 && !left.includes('dead00000001') && left.includes('old000000002')
    && left.includes(codePlain), `before=${before} left=${left.length}`)
  ok('G2 清理不影响读侧：未过期码仍在 /api/enroll 列表里',
    (await get('/api/enroll')).json().codes.some((c) => c.code_tail === codePlain.slice(-4)))
}

// ---------- H. the reset script (H13's fixable half) ----------
{
  const run = (args) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(HERE, 'reset-admin-pass.mjs'), ...args], {
      cwd: SERVER, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buf = ''
    c.stdout.on('data', (d) => { buf += d; if (process.env.HM_VERBOSE) process.stdout.write(`[rs] ${d}`) })
    c.stderr.on('data', (d) => { buf += d })
    c.on('exit', (code) => resolve({ code, out: buf }))
  })
  const none = await run(['--db', path.join(DIR, 'nope.db')])
  ok('H1 找不到库时明确拒绝并给出原因（不是静默成功）',
    none.code === 2 && none.out.includes('NO-DB') && !none.out.includes('DONE'), none.out.slice(0, 60))
  const dry = await run(['--db', ROSTER_DB])
  ok('H2 不带 --yes 只报告状态，且只报哈希方案不报原文',
    dry.out.includes('DRY-RUN') && dry.out.includes('scrypt')
    && !dry.out.includes(PASS) && roster.hasPassphrase() === true, dry.out.split('\n')[0])
  const gone = await run(['--db', ROSTER_DB, '--yes'])
  const refused = await post('/api/roster/hyg-box/name', { name: '还想改' }, PASS)
  ok('H3 --yes 之后口令真的没了：进程内的活 Server 立刻回到写侧默认拒绝',
    gone.out.includes('DONE') && roster.hasPassphrase() === false
    && refused.status === 403 && refused.text.includes('未设置管理口令'),
    `${gone.out.split('\n')[0]} / HTTP ${refused.status}`)
  ok('H4 重置脚本不碰节点凭据（三台老 Agent 不受影响）',
    roster.get('hyg-box')?.enroll_token?.startsWith('sha256$') === true)
  const again = await post('/api/admin/passphrase', { passphrase: PASS })
  ok('H5 重置后可以在看板上重新立口令（走的就是同一条引导流程）',
    again.status === 200 && roster.hasPassphrase() === true
    && (await post('/api/roster/hyg-box/name', { name: '值守机' }, PASS)).status === 200)
}

// ---------- teardown ----------
history.db?.close?.()
roster.db?.close?.()
/* Same rule as the other self-tests: the throwaway dir only earns its keep when
   something failed. The in-process Server's sockets are still open when we get
   here, so removal is best-effort and the exit is explicit either way. */
if (!fail) {
  try { rmSync(DIR, { recursive: true, force: true }) } catch { /* still closing */ }
}
console.log(`\n[selftest-hygiene] pass=${pass} fail=${fail}${fail ? `   dir kept: ${DIR}` : ''}`)
process.exit(fail ? 1 : 0)
