/**
 * Persistence layer (P5): SQLite time-series + alert lifecycle storage.
 * Contract in P5-细化设计.md. Uses built-in node:sqlite (zero deps).
 *
 * Two-tier storage: samples_raw (5s, 7 days) -> roll job -> samples_1m
 * (1-min means, 30 days). Written from the broadcast tick in index.js;
 * alerts.js upserts alert lifecycle rows.
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  enabled: true,
  db_path: 'data/host-monitor.db',
  sample_interval_s: 5,
  raw_retention_days: 7,
  agg_retention_days: 30,
  chart_points: 96,
}

function loadConfig() {
  const cfgPath = process.env.HISTORY_CONFIG
    || path.join(__dirname, 'config', 'history.json')
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(cfgPath, 'utf8')) }
  } catch {
    console.log('[History] No history.json, using built-in defaults')
    return { ...DEFAULTS }
  }
}

const NUM_COLS = [
  'cpu_usage', 'cpu_temp', 'cpu_freq', 'mem_percent',
  'disk_worst', 'io_read', 'io_write', 'net_down', 'net_up',
]
const INSERT_COLS = `host_id, ts, ${NUM_COLS.join(', ')}, gpu_json, link_json`
const TABLE_DDL = `host_id TEXT NOT NULL, ts INTEGER NOT NULL,
  ${NUM_COLS.join(' REAL, ')} REAL, gpu_json TEXT, link_json TEXT,
  PRIMARY KEY (host_id, ts)`

const RANGES_MS = { '2h': 7_200_000, '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 }

const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100)

class History {
  constructor() {
    this.cfg = loadConfig()
    this.enabled = this.cfg.enabled
    if (!this.enabled) {
      console.log('[History] Persistence disabled (enabled:false), running in-memory only')
      return
    }

    const dbPath = path.isAbsolute(this.cfg.db_path)
      ? this.cfg.db_path
      : path.join(__dirname, '..', this.cfg.db_path)
    mkdirSync(path.dirname(dbPath), { recursive: true })

    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS samples_raw (${TABLE_DDL});
      CREATE TABLE IF NOT EXISTS samples_1m (${TABLE_DDL});
      CREATE TABLE IF NOT EXISTS alert_events (
        id TEXT PRIMARY KEY, host_id TEXT, hostname TEXT, metric TEXT, source TEXT,
        level TEXT, state TEXT, value_at_trigger REAL, latest_value REAL,
        threshold REAL, started_at INTEGER, resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_alert_time ON alert_events(started_at);
    `)

    const ph = NUM_COLS.map(() => '?').join(', ')
    const insertSql = (tbl) =>
      `INSERT OR IGNORE INTO ${tbl} (${INSERT_COLS}) VALUES (?, ?, ${ph}, ?, ?)`
    this.insertRaw = this.db.prepare(insertSql('samples_raw'))
    this.insert1m = this.db.prepare(insertSql('samples_1m'))
    this.upsertAlert = this.db.prepare(`
      INSERT INTO alert_events (id, host_id, hostname, metric, source, level, state,
        value_at_trigger, latest_value, threshold, started_at, resolved_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        hostname=excluded.hostname, level=excluded.level, state=excluded.state,
        latest_value=excluded.latest_value, started_at=excluded.started_at,
        resolved_at=excluded.resolved_at
    `)

    this.lastSampleAt = new Map()

    this.rollAndCleanup() // catch up after downtime
    this.rollTimer = setInterval(() => this.rollAndCleanup(), 3_600_000)
    this.rollTimer.unref?.()
    console.log(`[History] SQLite at ${dbPath} (sample ${this.cfg.sample_interval_s}s, ` +
      `raw ${this.cfg.raw_retention_days}d + 1m ${this.cfg.agg_retention_days}d)`)
  }

  // ---------- write path ----------

  /** Called from the broadcast tick with annotated hosts; throttled per host. */
  onBroadcast(hosts) {
    if (!this.enabled) return
    const now = Date.now()
    const every = this.cfg.sample_interval_s * 1000
    for (const host of hosts) {
      if (!host.online || !host.metrics) continue
      if (now - (this.lastSampleAt.get(host.host_id) || 0) < every) continue
      this.lastSampleAt.set(host.host_id, now)
      this.insertRaw.run(...this.frameToRow(host.host_id, now, host.metrics))
    }
  }

  frameToRow(hostId, ts, m) {
    const gpu = (m.gpu || []).map((g) => ({
      i: g.index ?? 0, u: g.usage_percent ?? null, t: g.temperature_c ?? null,
    }))
    const link = (m.probes?.results || []).map((p) => ({
      t: p.target, r: p.rtt_ms ?? null, l: p.loss_pct ?? null,
    }))
    return [
      hostId, ts,
      m.cpu?.usage_percent ?? null, m.cpu?.temperature_c ?? null, m.cpu?.freq_mhz ?? null,
      m.memory?.percent ?? null,
      m.disk?.worst_percent ?? null,
      m.disk?.io?.read_mb_s ?? null, m.disk?.io?.write_mb_s ?? null,
      m.network?.download_mbps ?? null, m.network?.upload_mbps ?? null,
      gpu.length ? JSON.stringify(gpu) : null,
      link.length ? JSON.stringify(link) : null,
    ]
  }

  /** Upsert one alert lifecycle entry (called by alerts.js). */
  recordAlert(e) {
    if (!this.enabled) return
    this.upsertAlert.run(
      e.id, e.host_id, e.hostname, e.metric, e.source, e.level, e.state,
      e.value_at_trigger ?? null, e.latest_value ?? null, e.threshold ?? null,
      e.started_at ?? null, e.resolved_at ?? null,
    )
  }

  activeAlertRows() {
    if (!this.enabled) return []
    return this.db.prepare(
      "SELECT * FROM alert_events WHERE state = 'active'").all()
  }

  alertHistory(limit = 200) {
    if (!this.enabled) return []
    return this.db.prepare(
      'SELECT * FROM alert_events ORDER BY started_at DESC LIMIT ?').all(limit)
  }

  // ---------- roll + retention ----------

  /** Aggregate complete, not-yet-rolled raw minutes into samples_1m; drop expired rows. */
  rollAndCleanup() {
    if (!this.enabled) return
    try {
      this.#roll()
      this.#cleanup()
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch (err) {
      console.error('[History] roll failed:', err.message)
    }
  }

  #roll() {
    const lastRow = this.db.prepare('SELECT MAX(ts) m FROM samples_1m').get()
    const rolledThrough = lastRow?.m != null ? Math.floor(lastRow.m / 60_000) * 60_000 : 0
    const completeEnd = Math.floor((Date.now() - 60_000) / 60_000) * 60_000
    if (completeEnd <= rolledThrough) return

    const rows = this.db.prepare(
      'SELECT * FROM samples_raw WHERE ts > ? AND ts < ? ORDER BY host_id, ts')
      .all(rolledThrough, completeEnd)

    // group by host + minute
    const groups = new Map()
    for (const r of rows) {
      const key = `${r.host_id}|${Math.floor(r.ts / 60_000) * 60_000}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(r)
    }
    for (const [key, g] of groups) {
      const sep = key.lastIndexOf('|')
      const hostId = key.slice(0, sep)
      const ts = Number(key.slice(sep + 1))
      const agg = [hostId, ts]
      for (const col of NUM_COLS) {
        const vals = g.map((r) => r[col]).filter((v) => v != null)
        agg.push(vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null)
      }
      agg.push(mergeJson(g.map((r) => r.gpu_json), 'i', ['u', 't']))
      agg.push(mergeJson(g.map((r) => r.link_json), 't', ['r', 'l']))
      this.insert1m.run(...agg)
    }
    console.log(`[History] rolled ${groups.size} host-minutes into samples_1m`)
  }

  #cleanup() {
    const now = Date.now()
    const rawCut = now - this.cfg.raw_retention_days * 86_400_000
    const aggCut = now - this.cfg.agg_retention_days * 86_400_000
    const d1 = this.db.prepare('DELETE FROM samples_raw WHERE ts < ?').run(rawCut)
    const d2 = this.db.prepare('DELETE FROM samples_1m WHERE ts < ?').run(aggCut)
    this.db.prepare(
      "DELETE FROM alert_events WHERE state = 'resolved' AND resolved_at < ?")
      .run(aggCut)
    if (d1.changes || d2.changes) {
      console.log(`[History] retention: -${d1.changes} raw, -${d2.changes} 1m rows`)
    }
  }

  // ---------- query ----------

  /** Column-oriented series payload per P5 design §5. */
  getSeries(hostId, range) {
    const empty = {
      host_id: hostId, range, bucket_ms: 0, points: 0, ts: [],
      cpu: { usage: [], temp: [], freq: [] },
      mem: { percent: [] },
      disk: { worst: [], io_read: [], io_write: [] },
      net: { down: [], up: [] },
      gpu: {}, link: {},
    }
    if (!this.enabled) return empty
    const span = RANGES_MS[range] || RANGES_MS['2h']
    const now = Date.now()
    const from = now - span
    const table = span <= RANGES_MS['24h'] ? 'samples_raw' : 'samples_1m'
    const bucket = Math.max(1000, Math.floor(span / this.cfg.chart_points / 1000) * 1000)

    const avgCols = NUM_COLS.map((c) => `AVG(${c}) AS ${c}`).join(', ')
    const numRows = this.db.prepare(`
      SELECT (ts - ts % ?) b, ${avgCols} FROM ${table}
      WHERE host_id = ? AND ts >= ? GROUP BY b ORDER BY b`).all(bucket, hostId, from)
    const jsonRows = this.db.prepare(`
      SELECT ts, gpu_json, link_json FROM ${table}
      WHERE host_id = ? AND ts >= ? ORDER BY ts`).all(hostId, from)

    // numeric columns
    const out = { ts: [], cpu_usage: [], cpu_temp: [], cpu_freq: [], mem_percent: [],
      disk_worst: [], io_read: [], io_write: [], net_down: [], net_up: [] }
    for (const r of numRows) {
      out.ts.push(r.b)
      for (const c of NUM_COLS) out[c].push(r[c] == null ? null : round2(r[c]))
    }

    // gpu + link series (app-layer bucket averaging over the same buckets)
    const gpuMap = new Map()  // index -> bucket -> {u:[], t:[]}
    const linkMap = new Map() // target -> bucket -> {r:[], l:[]}
    for (const r of jsonRows) {
      const b = r.ts - (r.ts % bucket)
      for (const g of parse(r.gpu_json)) {
        const m = getOr(gpuMap, g.i, new Map())
        const acc = getOr(m, b, { u: [], t: [] })
        if (g.u != null) acc.u.push(g.u)
        if (g.t != null) acc.t.push(g.t)
      }
      for (const p of parse(r.link_json)) {
        const m = getOr(linkMap, p.t, new Map())
        const acc = getOr(m, b, { r: [], l: [] })
        if (p.r != null) acc.r.push(p.r)
        if (p.l != null) acc.l.push(p.l)
      }
    }
    const gpuOut = {}
    for (const [idx, buckets] of gpuMap) {
      const { a: usage, b: temp } = alignSeries(out.ts, buckets, (x) => mean(x.u), (x) => mean(x.t))
      gpuOut[idx] = { ts: out.ts, usage, temp }
    }
    const linkOut = {}
    for (const [target, buckets] of linkMap) {
      const { a: rtt, b: loss } = alignSeries(out.ts, buckets, (x) => mean(x.r), (x) => mean(x.l))
      linkOut[target] = { ts: out.ts, rtt, loss }
    }

    return {
      host_id: hostId, range, bucket_ms: bucket, points: out.ts.length,
      ts: out.ts,
      cpu: { usage: out.cpu_usage, temp: out.cpu_temp, freq: out.cpu_freq },
      mem: { percent: out.mem_percent },
      disk: { worst: out.disk_worst, io_read: roundSeries(out.io_read), io_write: roundSeries(out.io_write) },
      net: { down: out.net_down, up: out.net_up },
      gpu: gpuOut, link: linkOut,
    }
  }
}

function parse(jsonStr) {
  if (!jsonStr) return []
  try { return JSON.parse(jsonStr) || [] } catch { return [] }
}
function getOr(map, key, dflt) {
  if (!map.has(key)) map.set(key, dflt)
  return map.get(key)
}
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null
}
function roundSeries(arr) {
  return arr.map((v) => (v == null ? null : round2(v)))
}
function alignSeries(tsList, buckets, fa, fb) {
  const a = [], b = []
  for (const t of tsList) {
    const acc = buckets.get(t)
    const va = acc ? fa(acc) : null
    const vb = acc ? fb(acc) : null
    a.push(va == null ? null : round2(va))
    b.push(vb == null ? null : round2(vb))
  }
  return { a, b }
}

/** JSON-array merge for roll: key field + numeric fields -> averaged JSON. */
function mergeJson(jsonStrings, keyField, valFields) {
  const acc = new Map()
  for (const s of jsonStrings) {
    for (const item of parse(s)) {
      const a = getOr(acc, item[keyField], Object.fromEntries(
        [keyField, ...valFields].map((f) => [f, f === keyField ? item[keyField] : []])))
      for (const f of valFields) {
        if (item[f] != null) a[f].push(item[f])
      }
    }
  }
  if (!acc.size) return null
  const out = [...acc.values()].map((a) => Object.fromEntries(
    Object.entries(a).map(([k, v]) =>
      [k, Array.isArray(v) ? (v.length ? round2(mean(v)) : null) : v])))
  return JSON.stringify(out)
}

export const history = new History()
