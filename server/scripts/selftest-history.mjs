/**
 * P5 self-test: roll + retention + query against a throwaway DB.
 * Usage: node scripts/selftest-history.mjs   (no server needed)
 */
import { writeFileSync } from 'fs'
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
console.log('T1 restore-active (expect 0, already resolved):', acts.length === 0 ? 'PASS' : 'FAIL')
const hist = history.alertHistory(10)
console.log('T2 alert row upserted once (expect 1, state=resolved):',
  hist.length === 1 && hist[0].state === 'resolved' ? 'PASS' : 'FAIL')

// --- roll ---
const before = db.prepare('SELECT COUNT(*) c FROM samples_raw').get().c
history.rollAndCleanup()
const rolled = db.prepare('SELECT * FROM samples_1m ORDER BY ts').all()
// rolled[0] = isolated old row's minute, rolled[1..3] = the 3 seeded full minutes
console.log('T3 rolled minutes (expect 4 rows):', rolled.length === 4 ? 'PASS' : 'FAIL', rolled.map(r => r.ts))
// minute 2 = i in 12..23 -> cpu 52..63 avg 57.5
console.log('T4 minute mean cpu_usage (expect 57.5):',
  rolled[2]?.cpu_usage === 57.5 ? 'PASS' : 'FAIL', rolled[2]?.cpu_usage)
const g = JSON.parse(rolled[2].gpu_json)
console.log('T5 gpu_json averaged (u expect 27.5, t 55):',
  g[0].i === 0 && g[0].u === 27.5 && g[0].t === 55 ? 'PASS' : 'FAIL', JSON.stringify(g))
const l = JSON.parse(rolled[2].link_json)
console.log('T6 link_json averaged (r expect 2.75):',
  l[0].t === 'server' && l[0].r === 2.75 ? 'PASS' : 'FAIL', JSON.stringify(l))

// --- retention ---
const after = db.prepare('SELECT COUNT(*) c FROM samples_raw').get().c
console.log(`T7 raw retention (seeded ${before}, expect 0 expired-by-3min rows kept only if recent):`,
  after < before ? `PASS (${before} -> ${after})` : `FAIL (${after})`)
const recentKept = db.prepare('SELECT COUNT(*) c FROM samples_raw WHERE ts > ?').get(now - 2 * 60_000).c
console.log('T8 recent raw survives retention:', recentKept === 0 ? 'PASS (all >3min old)' : `note ${recentKept}`)

// --- query from 1m table (7d range) ---
const s = history.getSeries('t1', '7d')
console.log('T9 7d query points:', s.points, s.points > 0 ? 'PASS' : 'FAIL',
  '| cpu.usage:', s.cpu.usage.join(','), '| gpu0.u:', s.gpu['0']?.usage.join(','))
const s2 = history.getSeries('nope', '2h')
console.log('T10 unknown host empty:', s2.points === 0 ? 'PASS' : 'FAIL')

db.close()
console.log('[selftest] done, db:', dbPath)
