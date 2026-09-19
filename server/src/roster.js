/**
 * Roster (S1): the fleet as a persisted fact, not "whatever is connected right now".
 * Contract: S1-细化设计.md §2-§5.
 *
 * Why a separate SQLite file: the history DB takes a write every sample tick,
 * while roster writes are rare (user actions + throttled last_seen). Keeping
 * them apart means the hot ingest path never contends with the roster for the
 * WAL write lock. The history DB is opened again, read-only in effect, only at
 * startup to seed the roster from host_ids that already have history (S1 §4).
 *
 * presence_class semantics (S1 §3.1) — the whole point of this module:
 *   persistent  shown, counts in online/total, participates in health merge,
 *               heartbeat loss -> OFFLINE alert (unchanged v1 behaviour)
 *   ephemeral   shown as ABSENT when offline, excluded from health + denominator,
 *               heartbeat loss -> presence event only, never an alert
 *   retired     not shown at all, excluded from every aggregate; its history
 *               stays queryable by host_id
 */
import { DatabaseSync } from 'node:sqlite'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.join(__dirname, '..')

export const CLASSES = ['persistent', 'ephemeral', 'retired']
export const KINDS = ['agent', 'demo', 'observed']

// last_seen hits the disk at most this often per node (S1 §7: no DB churn on
// the 2s metrics path; the in-memory store is authoritative for "now").
const SEEN_WRITE_MS = 30_000
// Name prefixes for demo nodes are enforced server-side, never by convention
// (S1 §6 - honesty rule: aggregates must stay explainable).
const DEMO_PREFIX = '模拟-'
const PASS_MIN_LEN = 4

/** Roster DB file. HM_ROSTER_DB lets the self-test point at a throwaway file. */
function resolveRosterDb() {
  const p = process.env.HM_ROSTER_DB || path.join(SERVER_ROOT, 'data', 'roster.db')
  mkdirSync(path.dirname(p), { recursive: true })
  return p
}

/** Resolve the history DB path exactly the way history.js does (seed query only). */
function historyDbPath() {
  const cfgPath = process.env.HISTORY_CONFIG
    || path.join(__dirname, 'config', 'history.json')
  let rel = 'data/host-monitor.db'
  try {
    rel = JSON.parse(readFileSync(cfgPath, 'utf8')).db_path || rel
  } catch { /* no history.json -> built-in default */ }
  return path.isAbsolute(rel) ? rel : path.join(SERVER_ROOT, rel)
}

function parseSettings(row) {
  try { return JSON.parse(row.settings_json) || {} } catch { return {} }
}

class Roster {
  constructor() {
    this.dbFile = resolveRosterDb()
    this.db = new DatabaseSync(this.dbFile)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        host_id        TEXT PRIMARY KEY,
        display_name   TEXT NOT NULL,
        hostname       TEXT,
        role           TEXT,
        owner          TEXT NOT NULL DEFAULT 'me',
        site           TEXT NOT NULL DEFAULT 'home',
        kind           TEXT NOT NULL DEFAULT 'agent',
        presence_class TEXT NOT NULL DEFAULT 'persistent',
        confirmed      INTEGER NOT NULL DEFAULT 0,
        enrolled_at    INTEGER,
        last_seen      INTEGER,
        agent_version  TEXT,
        enroll_token   TEXT,
        fingerprint    TEXT,
        settings_json  TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)

    this.insert = this.db.prepare(`
      INSERT INTO nodes (host_id, display_name, hostname, role, owner, site, kind,
        presence_class, confirmed, enrolled_at, last_seen, agent_version, enroll_token,
        fingerprint, settings_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    this.update = this.db.prepare(`
      UPDATE nodes SET display_name=?, hostname=?, role=?, owner=?, site=?, kind=?,
        presence_class=?, confirmed=?, last_seen=?, agent_version=?, enroll_token=?,
        fingerprint=?, settings_json=?
      WHERE host_id=?`)

    // Full in-memory copy: the 2s broadcast path reads this, never SQL.
    this.cache = new Map()
    this.reload()

    this.seeded = this.#seedFromHistory()
    console.log(`[Roster] ${this.dbFile} (${this.cache.size} node(s)` +
      (this.seeded ? `, seeded ${this.seeded} from history` : '') +
      `, admin passphrase ${this.hasPassphrase() ? 'set' : 'NOT set -> writes disabled'})`)
  }

  // ---------- load / seed ----------

  reload() {
    this.cache.clear()
    for (const row of this.db.prepare('SELECT * FROM nodes').all()) {
      this.cache.set(row.host_id, row)
    }
  }

  /** S1 §4: host_ids that already have history come back as persistent, so the
   *  three live nodes survive the upgrade with their ids and curves intact. */
  #seedFromHistory() {
    if (this.db.prepare('SELECT COUNT(*) c FROM nodes').get().c > 0) return 0
    const file = historyDbPath()
    if (!existsSync(file)) return 0
    let rows
    try {
      const h = new DatabaseSync(file)
      rows = h.prepare(`
        SELECT host_id, MAX(ts) AS last_ts FROM (
          SELECT host_id, ts FROM samples_raw
          UNION ALL SELECT host_id, ts FROM samples_1m
        ) GROUP BY host_id`).all()
      h.close()
    } catch (err) {
      console.log(`[Roster] history seed skipped: ${err.message}`)
      return 0
    }
    const now = Date.now()
    for (const r of rows) this.#insertNode(r.host_id, { hostname: r.host_id }, now, r.last_ts)
    return rows.length
  }

  // ---------- ingest path ----------

  /**
   * Called on every register/metrics frame. Creates the entry on first sight
   * (class persistent, confirmed=0 -> the dashboard offers to reclassify it).
   */
  ensure(hostId, info = {}) {
    let node = this.cache.get(hostId)
    if (!node) {
      node = this.#insertNode(hostId, info, Date.now(), null)
      console.log(`[Roster] New node auto-enrolled as persistent: ${hostId}` +
        (info.hostname ? ` (${info.hostname})` : ''))
      return node
    }
    // Keep the hardware-side facts fresh without ever letting them overwrite a
    // user-set display_name (S1 §2: renaming is a display concern, not identity).
    const patch = {}
    if (info.hostname && info.hostname !== node.hostname) patch.hostname = info.hostname
    if (info.role && info.role !== node.role) patch.role = info.role
    if (info.agent_version && info.agent_version !== node.agent_version) patch.agent_version = info.agent_version
    if (info.token && info.token !== node.enroll_token) patch.enroll_token = info.token
    if (info.fingerprint && info.fingerprint !== node.fingerprint) patch.fingerprint = info.fingerprint
    if (Object.keys(patch).length) {
      this.save({ ...node, ...patch })
    }
    return this.cache.get(hostId)
  }

  #insertNode(hostId, info, now, lastSeen) {
    const kind = info.kind || 'agent'
    const node = {
      host_id: hostId,
      display_name: this.#displayNameFor(hostId, info.hostname, kind),
      hostname: info.hostname || hostId,
      role: info.role || null,
      owner: 'me',
      site: 'home',
      kind,
      presence_class: 'persistent',
      confirmed: 0,
      enrolled_at: now,
      last_seen: lastSeen ?? now,
      agent_version: info.agent_version || null,
      enroll_token: info.token || null,
      fingerprint: info.fingerprint || null,
      settings_json: '{}',
    }
    this.insert.run(node.host_id, node.display_name, node.hostname, node.role, node.owner,
      node.site, node.kind, node.presence_class, node.confirmed, node.enrolled_at,
      node.last_seen, node.agent_version, node.enroll_token, node.fingerprint,
      node.settings_json)
    this.cache.set(hostId, node)
    return node
  }

  #displayNameFor(hostId, hostname, kind) {
    const base = hostname || hostId
    // S1 §6: demo names are prefixed server-side, never left to whoever runs
    // the mock agent.
    return kind === 'demo' && !base.startsWith(DEMO_PREFIX) ? `${DEMO_PREFIX}${base}` : base
  }

  save(node) {
    this.update.run(node.display_name, node.hostname, node.role, node.owner, node.site,
      node.kind, node.presence_class, node.confirmed, node.last_seen, node.agent_version,
      node.enroll_token, node.fingerprint, node.settings_json, node.host_id)
    this.cache.set(node.host_id, node)
    return node
  }

  /** Throttled heartbeat persistence (in-memory store owns "online right now"). */
  markSeen(hostId, now = Date.now()) {
    const node = this.cache.get(hostId)
    if (!node) return
    if (now - (this._seenWrites?.get(hostId) || 0) < SEEN_WRITE_MS) return
    this._seenWrites = this._seenWrites || new Map()
    this._seenWrites.set(hostId, now)
    this.save({ ...node, last_seen: now })
  }

  // ---------- reads for the annotate path ----------

  get(hostId) { return this.cache.get(hostId) }
  classOf(hostId) { return this.cache.get(hostId)?.presence_class || 'persistent' }
  isConfirmed(hostId) { return !!this.cache.get(hostId)?.confirmed }

  /** Live fleet for the dashboard: everything the user has not retired. */
  active() {
    return [...this.cache.values()].filter((n) => n.presence_class !== 'retired')
  }
  retired() {
    return [...this.cache.values()].filter((n) => n.presence_class === 'retired')
  }
  /**
   * Guidance list for "a machine just showed up, tell the user to classify it".
   * Deliberately recency-gated (S1 §5.3): the history seed brings back every
   * host_id that ever reported, including long-dead dev mocks. Nagging about a
   * node last seen three weeks ago is noise, not guidance.
   */
  unconfirmed(windowMs = 24 * 3_600_000, now = Date.now()) {
    return [...this.cache.values()].filter((n) =>
      !n.confirmed && n.presence_class !== 'retired'
      && (n.last_seen ?? 0) > now - windowMs)
  }

  // ---------- writes (behind the admin passphrase) ----------

  setClass(hostId, cls, { confirmed = true } = {}) {
    if (!CLASSES.includes(cls)) return { ok: false, error: `unknown class: ${cls}` }
    const node = this.cache.get(hostId)
    if (!node) return { ok: false, error: 'no such node' }
    return { ok: true, node: this.save({ ...node, presence_class: cls, confirmed: confirmed ? 1 : 0 }) }
  }

  /**
   * Mute (S1 §3.3): suppresses this node's alerts in banner/list/sound only.
   * OFFLINE is exempt (availability is a fact worth waking up for) - enforced
   * in alerts.js, not here. `until: null` cancels.
   */
  setMute(hostId, until) {
    const node = this.cache.get(hostId)
    if (!node) return { ok: false, error: 'no such node' }
    const s = parseSettings(node)
    if (until === null) delete s.mute
    else s.mute = { until }
    return { ok: true, node: this.save({ ...node, settings_json: JSON.stringify(s) }) }
  }

  mutedUntil(hostId, now = Date.now()) {
    const node = this.cache.get(hostId)
    if (!node) return null
    const m = parseSettings(node).mute
    if (!m) return null
    const until = m.until === 'today'
      ? new Date(new Date().setHours(24, 0, 0, 0)).getTime()
      : Number(m.until)
    if (!Number.isFinite(until) || until <= now) return null
    return until
  }

  isMuted(hostId, now = Date.now()) { return this.mutedUntil(hostId, now) !== null }

  /**
   * Every currently-muted host id, straight from the roster. The alert engine
   * needs this instead of filtering the live host list: a muted node that has
   * not reconnected yet (Server restart, Agent blip) is simply not in the
   * store, and treating "not in the store" as "not muted" would let its frozen
   * alert age out into a fake 已恢复.
   */
  mutedIds(now = Date.now()) {
    return [...this.cache.keys()].filter((id) => this.isMuted(id, now))
  }

  setDisplay(hostId, name) {
    const node = this.cache.get(hostId)
    if (!node) return { ok: false, error: 'no such node' }
    const clean = String(name || '').trim().slice(0, 40)
    if (!clean) return { ok: false, error: 'empty name' }
    return { ok: true, node: this.save({ ...node, display_name: clean }) }
  }

  // ---------- admin passphrase (S1 §5.2: default deny) ----------

  hasPassphrase() {
    return !!this.db.prepare("SELECT value FROM meta WHERE key = 'admin_pass'").get()
  }

  setPassphrase(next, old) {
    if (typeof next !== 'string' || next.length < PASS_MIN_LEN) {
      return { ok: false, error: `口令至少 ${PASS_MIN_LEN} 位` }
    }
    if (this.hasPassphrase() && !this.checkPassphrase(old)) {
      return { ok: false, error: '原口令不正确' }
    }
    const salt = randomBytes(16).toString('hex')
    const hash = scryptSync(next, salt, 64).toString('hex')
    this.db.prepare(`
      INSERT INTO meta (key, value) VALUES ('admin_pass', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(`scrypt$${salt}$${hash}`)
    return { ok: true }
  }

  checkPassphrase(pass) {
    if (typeof pass !== 'string' || !pass) return false
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'admin_pass'").get()
    if (!row) return false
    const [scheme, salt, hash] = String(row.value).split('$')
    if (scheme !== 'scrypt' || !salt || !hash) return false
    const cand = scryptSync(pass, salt, 64)
    const want = Buffer.from(hash, 'hex')
    return cand.length === want.length && timingSafeEqual(cand, want)
  }

  /** Public projection: never leaks the token / fingerprint, only their state. */
  publicOf(hostId) {
    const n = this.cache.get(hostId)
    if (!n) return null
    return {
      host_id: n.host_id,
      display_name: n.display_name,
      role: n.role,
      owner: n.owner,
      site: n.site,
      kind: n.kind,
      presence_class: n.presence_class,
      confirmed: !!n.confirmed,
      last_seen: n.last_seen,
      agent_version: n.agent_version,
      muted_until: this.mutedUntil(hostId),
      has_credential: !!n.enroll_token,
    }
  }
}

export const roster = new Roster()
