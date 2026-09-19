/**
 * S5 §4 self-test: the ZeroTier presence ledger, against a stub local API.
 * Usage: node scripts/selftest-zt-presence.mjs
 *
 * What this can and cannot prove (S5 §8): the *logic* — reachability, naming,
 * ambiguity, masking, persistence, "the source is down but the ledger still
 * answers" — is all checkable here. Reading a real ZeroTier daemon is not:
 * `authtoken.secret` is admin-only on this box, so the end-to-end poll is a
 * confirmed-on-deploy item, not something this file may claim.
 *
 * The second job is G4 against the live store rather than the import graph: a
 * peer must never become a node.
 */
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { createServer } from 'http'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = mkdtempSync(path.join(tmpdir(), 'hm-zt-'))
process.env.HISTORY_CONFIG = path.join(DIR, 'history.json')
process.env.HM_ROSTER_DB = path.join(DIR, 'roster.db')
writeFileSync(process.env.HISTORY_CONFIG, JSON.stringify({
  enabled: true, db_path: path.join(DIR, 'history.db'), sample_interval_s: 5,
  raw_retention_days: 7, agg_retention_days: 30, chart_points: 96,
}))
// Deliberately no such file: the disabled shape is asserted first, and only then
// does the module get pointed at the stub.
process.env.HM_ZT_CONFIG = path.join(DIR, 'zt.json')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `   ${extra}` : ''}`)
}

const { roster } = await import('../src/roster.js')
const { ztPresence } = await import('../src/zerotier.js')
const { store } = await import('../src/store.js')

// ---------- the fleet, as the roster knows it ----------
roster.ensure('n-231', { hostname: 'SRV-231', role: 'server' })
roster.ensure('n-142', { hostname: 'inference-142', role: 'gpu' })
roster.ensure('dup-1', { hostname: 'BOX' })
roster.ensure('dup-2', { hostname: 'box' })   // same name, two machines
roster.setClass('n-231', 'persistent', { confirmed: true })

// ---------- P0: the disabled shape ----------
{
  const off = ztPresence.info()
  ok('P0 缺 zt.json 时是结构化空态而不是报错：enabled:false + reason:no-config + 零行',
    off.enabled === false && off.reason === 'no-config' && off.source_ok === false
    && Array.isArray(off.peers) && off.peers.length === 0 && off.counts.visible === 0,
    JSON.stringify({ e: off.enabled, r: off.reason, c: off.counts }))
  ok('P0b 空态里带着可操作的说明字段（UI 要能说"为什么是空的"）',
    typeof off.reason === 'string' && off.last_poll_at === null)
}

// ---------- the stub ZeroTier local API ----------
const TOKEN = 'stub-zt-token-must-never-travel'
let mode = 'ok'
let peers = []
const stub = createServer((req, res) => {
  req.resume()
  if (req.headers['authorization'] !== TOKEN) { res.writeHead(401); res.end('bad token'); return }
  if (mode === 'boom') { res.writeHead(500); res.end(`kaboom http://127.0.0.1:${PORT}/getPeers ${TOKEN}`); return }
  if (mode === 'shape') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"not":"an array"}')
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(peers))
})
const PORT = await new Promise((resolve) => stub.listen(0, '127.0.0.1', () => resolve(stub.address().port)))

const LOCAL = 'ffffffff00'
const PLANET = '88417a53e6'
peers = [
  // the box itself: never "a device that is present elsewhere"
  { address: LOCAL, name: 'MY-BOARD', latency: 0, localPeer: true },
  // a root/planet: reachable, but not a machine anybody owns
  { address: PLANET, name: 'planet.arcc.ZeroTier.com', latency: 24 },
  // reachable + names itself exactly as the Agent reported -> auto match
  { address: 'aa11bb22cc', name: 'SRV-231', latency: 12.4, version: '1.16.2' },
  // reachable + a name the roster does not know -> only a manual binding names it
  { address: 'dd44ee55ff', name: 'friends-laptop', latency: 38 },
  // reachable + an ambiguous name (two roster boxes both report BOX) -> no guess
  { address: 'ababab1234', name: 'BOX', latency: 5 },
  // ZeroTier has no path to it right now (-1 = unknown), and it tells us no name
  { address: 'cc00cc00cc', name: null, latency: -1 },
  // not a node address at all
  { address: 'nope', name: 'garbage', latency: 3 },
]

ztPresence.setEndpoint({ port: PORT, token: TOKEN })
ztPresence.cfg.exclude = [PLANET.slice(0, 6)]
await ztPresence.poll()
const info = ztPresence.info()
const by = (a) => info.peers.find((p) => p.zt_addr === a)

// ---------- P1: what earns a row ----------
ok('P1 本机 peer / 排除掉的行星节点 / 形态不对的地址都不进台账',
  !info.peers.some((p) => [LOCAL, PLANET, 'nope'].includes(p.zt_addr)))
ok('P2 在场判据 = latency>=0：-1 的行仍在台账里但不算在场',
  by('cc00cc00cc')?.reachable === false && info.counts.present === 3
  && info.counts.visible === 4, JSON.stringify(info.counts))
ok('P3 延迟取整、版本截断；不可达行没有 last_seen（不能拿"试过"当"见过"）',
  by('aa11bb22cc')?.latency_ms === 12 && by('aa11bb22cc')?.version === '1.16.2'
  && by('cc00cc00cc')?.last_seen === null)

// ---------- P2: naming ----------
ok('P4 与名册 hostname 唯一同名 -> 自动归名，并带出名册显示名',
  by('aa11bb22cc')?.host_id === 'n-231' && by('aa11bb22cc')?.matched_by === 'name'
  && by('aa11bb22cc')?.display_name === 'SRV-231', JSON.stringify(by('aa11bb22cc')))
ok('P5 名册里没见过的名字：未归名而不是错误（手工映射是兜底路径）',
  by('dd44ee55ff')?.host_id === null && by('dd44ee55ff')?.matched_by === null
  && by('dd44ee55ff')?.ambiguous === false)
ok('P6 同名两台时不猜：host_id 留空并标 ambiguous，交回给用户映射',
  by('ababab1234')?.host_id === null && by('ababab1234')?.ambiguous === true,
  JSON.stringify(by('ababab1234')))

// ---------- P3: the manual binding ----------
{
  const bad = roster.setPresenceAlias('not-an-addr', 'n-231')
  const ghost = roster.setPresenceAlias('dd44ee55ff', 'no-such-node')
  ok('P7 地址形态与名册存在性都校验：绑到不存在的节点会被拒，不会静默留一行',
    bad.ok === false && ghost.ok === false, JSON.stringify({ bad, ghost }))
  roster.setPresenceAlias('dd44ee55ff', 'n-142')
  const after = ztPresence.info().peers.find((p) => p.zt_addr === 'dd44ee55ff')
  ok('P8 手工绑定优先于名字，matched_by 说明这一行是怎么来的',
    after?.host_id === 'n-142' && after?.matched_by === 'alias'
    && after?.display_name === 'inference-142', JSON.stringify(after))
  roster.setPresenceAlias('ababab1234', null, '客厅的小米盒子')
  const labeled = ztPresence.info().peers.find((p) => p.zt_addr === 'ababab1234')
  ok('P9 可以只贴标签不绑节点：歧义被人工解除，行也不再是"未归名"',
    labeled?.label === '客厅的小米盒子' && labeled?.host_id === null
    && labeled?.ambiguous === false, JSON.stringify(labeled))
  const named = ztPresence.info().counts.named
  ok('P10 "已归名 n" 数的是能认出是谁的行：3 台（名字 1 + 绑定 1 + 标签 1）',
    named === 3, `named=${named}`)
  const long = roster.setPresenceAlias('ababab1234', null, 'x'.repeat(80))
  ok('P11 标签长度有上限（它会被印在一块常开的屏上）',
    long.ok === true && long.alias.label.length === 40)
  roster.setPresenceAlias('ababab1234', null, null)
  ok('P12 绑定与标签都清空时删行，不留一行谁也不认识的东西',
    !roster.presenceAliases().has('ababab1234'))
  roster.setPresenceAlias('dd44ee55ff', null, null)
}

// ---------- P4: persistence, and the ledger's memory ----------
{
  const states = roster.presenceStates()
  ok('P13 只有真正在场的 peer 才写 presence_state（不可达不等于"来过"）',
    states.length === 3 && !states.some((s) => s.zt_addr === 'cc00cc00cc'),
    states.map((s) => s.zt_addr).join(' '))
  ok('P14 同一台在节流窗口内不重复写盘（30s 轮询不该变成 30s 一次 IO）',
    roster.notePresence({ ztAddr: 'aa11bb22cc', name: 'SRV-231', latency: 9 }, Date.now() + 5_000) === false
    && roster.notePresence({ ztAddr: 'aa11bb22cc', name: 'SRV-231', latency: 9 }, Date.now() + 61_000) === true)
  const firstSeen = by('aa11bb22cc')?.first_seen
  peers = peers.filter((p) => p.address !== 'dd44ee55ff')
  await ztPresence.poll()
  const again = ztPresence.info()
  const gone = again.peers.find((p) => p.zt_addr === 'dd44ee55ff')
  ok('P15 本轮没再看到的 peer 不会消失：以 remembered+不可达留下，last_seen 是台账里的最后一次',
    !!gone && gone.remembered === true && gone.reachable === false && !!gone.last_seen,
    JSON.stringify(gone))
  ok('P16 first_seen 取自台账而不是本轮（"它今晚在不在"重启后仍要答得出）',
    !!firstSeen && again.peers.find((p) => p.zt_addr === 'aa11bb22cc')?.first_seen === firstSeen)
  ok('P16b 排序把在场的放在前面，其余按最后一次可见倒序',
    again.peers[0]?.reachable === true
    && again.peers.findIndex((p) => p.reachable === false) > 0)
  const visible = again.counts.visible
}

// ---------- P5: a dead source is a degraded source, not an incident ----------
{
  const visible = ztPresence.info().counts.visible
  mode = 'boom'
  await ztPresence.poll()
  const down = ztPresence.info()
  ok('P17 5xx 只留下错误类别：异常文本（可能带 URL 和令牌）不进任何返回体',
    down.source_ok === false && down.error === 'http-500'
    && !JSON.stringify(down).includes('kaboom') && !JSON.stringify(down).includes(TOKEN),
    JSON.stringify({ ok: down.source_ok, e: down.error }))
  ok('P18 源不可用时台账照常回答最后一次看到的东西：不清空、不报错、不报警',
    down.counts.visible === visible && down.last_ok_at > 0, `${down.counts.visible}/${visible}`)
  mode = 'shape'
  await ztPresence.poll()
  ok('P19 返回体不是数组时判为 bad-shape，而不是把半截结构当台账',
    ztPresence.info().error === 'bad-shape')
  const saved = process.env.HM_ZT_TOKEN
  process.env.HM_ZT_TOKEN = 'wrong-token'
  await ztPresence.poll()
  ok('P20 令牌不对时是 http-401 而不是"没有设备"：空台账不能被当成在场事实',
    ztPresence.info().error === 'http-401' && ztPresence.info().counts.visible === visible)
  process.env.HM_ZT_TOKEN = saved
  mode = 'ok'
  await ztPresence.poll()
  ok('P21 恢复后 source_ok 回到 true、error 清空（一次成功即够，不需要连续确认）',
    ztPresence.info().source_ok === true && ztPresence.info().error === null)
  ok('P22 令牌本身从不出现在配置回显或台账里（它只活在这个进程）',
    !JSON.stringify(ztPresence.cfg).includes(TOKEN)
    && !JSON.stringify(ztPresence.info()).includes(TOKEN))
}

// ---------- P6: G4 against the live store ----------
{
  store.register('n-231', { hostname: 'SRV-231', platform: 'linux', role: 'server' })
  store.updateMetrics('n-231', { host_id: 'n-231', hostname: 'SRV-231', cpu: { usage_percent: 20 } })
  const snap = store.getSnapshot()
  const text = JSON.stringify(snap)
  const addrs = ztPresence.info().peers.map((p) => p.zt_addr)
  ok('P23 快照里只有一个真节点：没有 peer 地址、没有 zt_addr 字段、没有在场计数',
    snap.hosts.length === 1 && snap.hosts[0].host_id === 'n-231'
    && !text.includes('zt_addr') && !addrs.some((a) => text.includes(a)),
    JSON.stringify({ hosts: snap.hosts.map((h) => h.host_id), peers: addrs.length }))
  ok('P24 peer 地址不会被写进名册：台账与节点是两张表，不是一张',
    addrs.every((a) => !roster.get(a)) && roster.active().length === 4,
    `nodes=${roster.active().length} peers=${addrs.length}`)
  /* Comment-proof: read the actual import specifiers. "It does not import the
     four-state path" is only worth anything as a check on what the module
     requires, not on words that appear in its own header. */
  const src = readFileSync(path.join(HERE, '..', 'src', 'zerotier.js'), 'utf8')
  const specs = [...src.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  const local = specs.filter((s) => s.startsWith('.'))
  ok('P25 zerotier.js 的本地依赖只有 roster：它拿不到 store/status/alerts/history，也就没有报警能力',
    local.length === 1 && local[0] === './roster.js'
    && !specs.some((s) => /store|status|alerts|history|events/.test(s)), local.join(' '))
}

stub.close()
if (!fail) {
  try { rmSync(DIR, { recursive: true, force: true }) } catch { /* best effort */ }
}
console.log(`\n[selftest-zt-presence] pass=${pass} fail=${fail}${fail ? `   dir kept: ${DIR}` : ''}`)
process.exit(fail ? 1 : 0)
