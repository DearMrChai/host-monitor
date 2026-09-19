/**
 * P5 self-test: roll + retention + query against a throwaway DB.
 * Usage: node scripts/selftest-history.mjs   (no server needed)
 */
import { writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const stamp = `${Date.now()}`
const dbPath = path.join(tmpdir(), `hm-p5-test-${stamp}.db`)
const cfgPath = path.join(tmpdir(), `hm-p5-cfg-${stamp}.json`)
writeFileSync(cfgPath, JSON.stringify({
  enabled: true, db_path: dbPath, sample_interval_s: 1,
  raw_retention_days: 0.002,   // ~3 min
  agg_retention_days: 30, chart_points: 96,
}))
process.env.HISTORY_CONFIG = cfgPath

const { history } = await import('../src/history.js')
const db = history.db
const now = Date.now()

/* This suite used to print PASS/FAIL and always exit 0, so a broken history.js
   stayed green - the same class of hole S2b recorded for exit-code assertions.
   `check()` is the one place a result becomes both a line and a verdict. */
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `   ${detail}` : ''}`)
}

// --- seed: 3 exact minutes of 5s samples for host t1, ending ~10 min ago ---
const m0 = Math.floor((now - 12 * 60_000) / 60_000) * 60_000
const seed = db.prepare(`INSERT OR IGNORE INTO samples_raw
  (host_id, ts, cpu_usage, cpu_temp, cpu_freq, mem_percent, disk_worst, io_read, io_write, net_down, net_up, gpu_json, link_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
for (let i = 0; i < 36; i++) {
  seed.run('t1', m0 + i * 5_000, 40 + i, null, 3000, 50, 60, 1, 2, 10, 1,
    JSON.stringify([{ i: 0, u: 10 + i, t: 55 }]),
    JSON.stringify([{ t: 'server', r: 1 + i * 0.1, l: 0 }]))
}
// one old row beyond raw retention (13 min before the seed window)
seed.run('t1', m0 - 13 * 60_000, 5, null, 3000, 5, 5, 0, 0, 0, 0, null, null)

// --- alert upsert lifecycle ---
history.recordAlert({ id: 't1|cpu_usage|cpu', host_id: 't1', hostname: 't1', metric: 'cpu_usage', source: 'cpu', level: 'WARN', state: 'active', value_at_trigger: 81, latest_value: 85, threshold: 80, started_at: now - 60_000, resolved_at: null })
history.recordAlert({ id: 't1|cpu_usage|cpu', host_id: 't1', hostname: 't1', metric: 'cpu_usage', source: 'cpu', level: 'WARN', state: 'resolved', value_at_trigger: 81, latest_value: 70, threshold: 80, started_at: now - 60_000, resolved_at: now - 10_000 })
const acts = history.activeAlertRows()
check('T1 restore-active (expect 0, already resolved)', acts.length === 0, `n=${acts.length}`)
const hist = history.alertHistory(10)
check('T2 alert row upserted once (expect 1, state=resolved)',
  hist.length === 1 && hist[0].state === 'resolved', JSON.stringify(hist.map(r => r.state)))

// --- roll ---
const before = db.prepare('SELECT COUNT(*) c FROM samples_raw').get().c
history.rollAndCleanup()
const rolled = db.prepare('SELECT * FROM samples_1m ORDER BY ts').all()
// rolled[0] = isolated old row's minute, rolled[1..3] = the 3 seeded full minutes
check('T3 rolled minutes (expect 4 rows)', rolled.length === 4, rolled.map(r => r.ts).join(','))
// minute 2 = i in 12..23 -> cpu 52..63 avg 57.5
check('T4 minute mean cpu_usage (expect 57.5)', rolled[2]?.cpu_usage === 57.5, rolled[2]?.cpu_usage)
const g = JSON.parse(rolled[2].gpu_json)
check('T5 gpu_json averaged (u expect 27.5, t 55)',
  g[0].i === 0 && g[0].u === 27.5 && g[0].t === 55, JSON.stringify(g))
const l = JSON.parse(rolled[2].link_json)
check('T6 link_json averaged (r expect 2.75)',
  l[0].t === 'server' && l[0].r === 2.75, JSON.stringify(l))

// --- retention ---
const after = db.prepare('SELECT COUNT(*) c FROM samples_raw').get().c
check(`T7 raw retention (seeded ${before}, expect the expired row dropped)`,
  after < before, `${before} -> ${after}`)
const recentKept = db.prepare('SELECT COUNT(*) c FROM samples_raw WHERE ts > ?').get(now - 2 * 60_000).c
check('T8 recent raw survives retention (seed is >3min old, so 0)', recentKept === 0, `kept=${recentKept}`)

// --- query from 1m table (7d range) ---
const s = history.getSeries('t1', '7d')
check('T9 7d query returns rolled points', s.points > 0,
  `points=${s.points} cpu.usage=${s.cpu.usage.join(',')} gpu0.u=${s.gpu['0']?.usage.join(',')}`)
const s2 = history.getSeries('nope', '2h')
check('T10 unknown host empty', s2.points === 0, `points=${s2.points}`)

db.close()
/* Throwaway files stay behind only when something failed - that is the whole
   point of printing the path. 22 of these per day is how a dev box fills up. */
if (!fail) {
  rmSync(dbPath, { force: true })
  rmSync(cfgPath, { force: true })
  for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
}
console.log(`\n[selftest-history] pass=${pass} fail=${fail}${fail ? `   db kept: ${dbPath}` : ''}`)
process.exit(fail ? 1 : 0)
