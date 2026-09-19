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
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { record as recordEvent } from './events.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.join(__dirname, '..')

export const CLASSES = ['persistent', 'ephemeral', 'retired']
export const KINDS = ['agent', 'demo', 'observed']

// last_seen hits the disk at most this often per node (S1 §7: no DB churn on
// the 2s metrics path; the in-memory store is authoritative for "now").
const SEEN_WRITE_MS = 30_000
// Same idea for the presence ledger, which is polled (S5 §4.2).
const PRESENCE_WRITE_MS = 60_000
// Name prefixes for demo nodes are enforced server-side, never by convention
// (S1 §6 - honesty rule: aggregates must stay explainable).
const DEMO_PREFIX = '模拟-'
const PASS_MIN_LEN = 4
/** On-disk shape of a stored node key (S5 §2). A pre-S5 row holds the bare
 *  32-hex key, which `keyMatches` still accepts and rewrites on the spot. */
const KEY_PREFIX = 'sha256$'

/**
 * Node keys are 128-bit random values, not human-chosen secrets, and
 * `keyMatches` runs on the Agent reconnect path of a low-power box — so a salted
 * SHA-256 is the right call here and scrypt would be the wrong one (80ms per
 * reconnect buys nothing against a 2^128 space). The admin passphrase right
 * below deliberately keeps scrypt: that one IS dictionary-attackable.
 * Different strategies on two adjacent lines are intentional, not an oversight.
 */
function hashNodeKey(plain, saltHex = randomBytes(16).toString('hex')) {
  return `${KEY_PREFIX}${saltHex}$${createHash('sha256').update(`${saltHex}:${plain}`).digest('hex')}`
}

function timingSafeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Does this candidate key satisfy this stored value? Accepts the pre-S5
 *  plaintext form so a rollback or a half-migrated DB never locks an Agent out;
 *  callers upgrade the row when it matches (roster.keyMatches / #migratePlainKeys). */
function keyMatchesStored(stored, plain) {
  if (!stored || typeof plain !== 'string' || !plain) return false
  if (!String(stored).startsWith(KEY_PREFIX)) return timingSafeEq(stored, plain)
  const parts = String(stored).split('$')
  if (parts.length !== 3 || !parts[1]) return false
  return timingSafeEq(hashNodeKey(plain, parts[1]), stored)
}

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

/**
 * "23:41" for a mute deadline. Only the *wording* is derived here - the epoch
 * stays in the event's detail_json, so changing this string never rewrites
 * history (S3 §2: stored rows are machine facts, rendered text is not).
 */
function untilText(until) {
  if (until === 'today') return '今天结束'
  const n = Number(until)
  if (!Number.isFinite(n)) return null
  const d = new Date(n)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
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
      CREATE TABLE IF NOT EXISTS enroll_codes (
        code        TEXT PRIMARY KEY,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        max_uses    INTEGER NOT NULL,
        uses        INTEGER NOT NULL DEFAULT 0,
        note        TEXT,
        paired_ids  TEXT NOT NULL DEFAULT ''
      );
      /* S5 §4.2: the ZeroTier presence ledger lives here too, because this is the
         only roster.db writer. It is a *ledger*, not a node table - nothing in
         store.js / status.js / alerts.js may read it (S5 G4). */
      CREATE TABLE IF NOT EXISTS presence_alias (
        zt_addr    TEXT PRIMARY KEY,
        host_id    TEXT,
        label      TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS presence_state (
        zt_addr      TEXT PRIMARY KEY,
        name         TEXT,
        first_seen   INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL,
        last_latency INTEGER
      );
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
    this.#migratePlainKeys()

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

  /** S5 §2: pre-S5 builds wrote the node key in plaintext. The plaintext is in
   *  hand right now, so the sweep needs no Agent and no re-pairing — after it,
   *  a stolen `roster.db` buys an attacker nothing they can put on the wire.
   *
   *  The rewrite alone is not enough for G1: SQLite leaves the old row image in
   *  a freed page and in the -wal file, where `strings roster.db` still finds
   *  it. So the sweep checkpoints and vacuums once — on a table this size that
   *  is milliseconds, and it is what makes "静态盘上读不到" actually true. */
  #migratePlainKeys() {
    let n = 0
    for (const node of this.cache.values()) {
      const stored = node.enroll_token
      if (!stored || stored.startsWith(KEY_PREFIX)) continue
      this.save({ ...node, enroll_token: hashNodeKey(stored) })
      n += 1
    }
    if (!n) return
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      this.db.exec('VACUUM')
    } catch (err) {
      console.log(`[Roster] key migration sweep skipped: ${err.message}`)
    }
    console.log(`[Roster] Migrated ${n} plaintext node key(s) to salted hashes (S5 G1)`)
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
    // Only the server-minted node key lands here, and it lands **hashed** (S5 §2).
    // The pairing code a frame may carry is a spend-once voucher (see
    // consumeEnroll) - storing it as the node's credential would let the same
    // code re-authorise forever.
    if (info.node_key && !keyMatchesStored(node.enroll_token, info.node_key)) {
      patch.enroll_token = hashNodeKey(info.node_key)
    }
    if (info.fingerprint && info.fingerprint !== node.fingerprint) patch.fingerprint = info.fingerprint
    if (info.confirmed && !node.confirmed) patch.confirmed = 1
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
      // A machine that arrived with a pairing code was added on purpose, so it
      // starts confirmed; one that simply showed up starts unconfirmed and the
      // dashboard asks the user to classify it (S1 §5.3).
      confirmed: info.confirmed ? 1 : 0,
      enrolled_at: now,
      last_seen: lastSeen ?? now,
      agent_version: info.agent_version || null,
      enroll_token: info.node_key ? hashNodeKey(info.node_key) : null,
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

  // ---------- pairing codes & node keys (S2 §2) ----------

  /**
   * Mint a pairing code: short-lived, spend-limited, shown in plaintext exactly
   * once (by the caller that issued it). It is NOT the node's standing
   * credential - a successful register swaps it for a per-node key, so a code
   * that leaks into a shell history or a screenshot dies on its own schedule.
   * `maxUses: 0` means unlimited until expiry (used for "add my whole bench").
   */
  issueEnroll({ ttlMin = 15, maxUses = 1, note = null } = {}, now = Date.now()) {
    const cap = Number.isFinite(Number(maxUses)) ? Math.max(0, Math.trunc(Number(maxUses))) : 1
    const ttl = Math.min(Math.max(Number(ttlMin) || 15, 1), 24 * 60) * 60_000
    const code = randomBytes(6).toString('hex')
    this.db.prepare(`
      INSERT INTO enroll_codes (code, created_at, expires_at, max_uses, uses, note, paired_ids)
      VALUES (?,?,?,?,0,?,?)`).run(code, now, now + ttl, cap, String(note || '').slice(0, 60), '')
    // The audit line carries the tail only, never the code itself: the plaintext
    // is deliberately held by exactly one response body (S2 §2).
    recordEvent({ kind: 'roster', code: 'code_issued', hostId: null, level: 'info',
      detail: { ttl_minutes: Math.round(ttl / 60_000), max_uses: cap, tail: code.slice(-4) } })
    return { code, expires_at: now + ttl, max_uses: cap }
  }

  /** Spend one use. Returns { ok, reason } - reason is UI text, never a secret.
   *  Reason strings match ingest.REASON_TEXT so the pairing page can show them. */
  consumeEnroll(code, hostId, now = Date.now()) {
    if (typeof code !== 'string' || !code) return { ok: false, reason: 'no_code' }
    const row = this.db.prepare('SELECT * FROM enroll_codes WHERE code = ?').get(code)
    if (!row) return { ok: false, reason: 'unknown_code' }
    if (row.expires_at <= now) return { ok: false, reason: 'code_expired' }
    if (row.max_uses && row.uses >= row.max_uses) return { ok: false, reason: 'code_used_up' }
    const paired = row.paired_ids ? row.paired_ids.split(',') : []
    if (hostId && !paired.includes(hostId)) paired.push(hostId)
    this.db.prepare('UPDATE enroll_codes SET uses = uses + 1, paired_ids = ? WHERE code = ?')
      .run(paired.join(','), code)
    return { ok: true, remaining: row.max_uses ? row.max_uses - row.uses - 1 : null }
  }

  /** Codes still inside their window - what the pairing page lists.
   *  `id` is the rowid on purpose: the page has to be able to revoke a code it
   *  can no longer see (the plaintext is shown once at mint time), and a
   *  tail-4 match would be a handle two machines could collide on. */
  activeCodes(now = Date.now()) {
    return this.db.prepare(
      'SELECT rowid AS id, code, created_at, expires_at, max_uses, uses, note, paired_ids FROM enroll_codes WHERE expires_at > ? ORDER BY created_at DESC LIMIT 20',
    ).all(now).map((r) => ({
      id: r.id, code: r.code, created_at: r.created_at, expires_at: r.expires_at,
      max_uses: r.max_uses, uses: r.uses, note: r.note,
      remaining: r.max_uses ? Math.max(0, r.max_uses - r.uses) : null,
      paired_ids: r.paired_ids ? r.paired_ids.split(',') : [],
    }))
  }

  /** Revoke by that non-secret handle. */
  revokeById(id) {
    const n = Number(id)
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'no such code' }
    const row = this.db.prepare('SELECT code FROM enroll_codes WHERE rowid = ?').get(n)
    const r = this.db.prepare('DELETE FROM enroll_codes WHERE rowid = ?').run(n)
    if (r.changes) this.#recordRevoke(row?.code)
    return { ok: r.changes > 0, error: r.changes ? null : 'no such code' }
  }

  revokeEnroll(code) {
    const r = this.db.prepare('DELETE FROM enroll_codes WHERE code = ?').run(code)
    if (r.changes) this.#recordRevoke(code)
    return { ok: r.changes > 0, error: r.changes ? null : 'no such code' }
  }

  #recordRevoke(code) {
    recordEvent({ kind: 'roster', code: 'code_revoked', hostId: null, level: 'info',
      detail: { tail: code ? String(code).slice(-4) : '?' } })
  }

  /**
   * Dead pairing codes are the one table that only ever grew: a code is spent or
   * expires, and nothing after that reads it (`activeCodes` filters on
   * expires_at, and the plaintext was shown exactly once). Registered on the
   * history retention clock (S3: one sweep, not four). The audit trail for a
   * code lives in `events`, so dropping the row loses no history (S5 §5.2).
   */
  purgeExpiredCodes(now = Date.now(), keepDays = 30) {
    const cut = now - keepDays * 86_400_000
    const r = this.db.prepare('DELETE FROM enroll_codes WHERE expires_at <= ?').run(cut)
    if (r.changes) console.log(`[Roster] retention: -${r.changes} dead enroll code(s)`)
    return r.changes
  }

  newNodeKey() { return randomBytes(16).toString('hex') }
  /** The stored (hashed) value. Not a credential and not usable as one — kept
   *  public only because `keylessAgents`/`has_credential` read its presence. */
  nodeKeyOf(hostId) { return this.cache.get(hostId)?.enroll_token || null }

  /** Standing per-node credential check. A match against a pre-S5 plaintext row
   *  upgrades that row on the spot, so the migration never has a cold window. */
  keyMatches(hostId, key) {
    const node = this.cache.get(hostId)
    if (!node) return false
    const ok = keyMatchesStored(node.enroll_token, key)
    if (ok && !String(node.enroll_token).startsWith(KEY_PREFIX)) {
      this.save({ ...node, enroll_token: hashNodeKey(key) })
    }
    return ok
  }

  /** Roster nodes without a key: the v1 Agents still reporting tokenlessly. */
  keylessAgents() {
    return [...this.cache.values()]
      .filter((n) => n.presence_class !== 'retired' && n.kind === 'agent' && !n.enroll_token)
      .map((n) => n.host_id)
  }

  /** Fingerprint drift: same id, different machine (S2 §3 residual-risk note). */
  fingerprintOf(hostId) { return this.cache.get(hostId)?.fingerprint || null }

  demoNodes() {
    return [...this.cache.values()]
      .filter((n) => n.kind === 'demo' && n.presence_class !== 'retired')
      .map((n) => n.host_id)
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

  setClass(hostId, cls, { confirmed = true, silent = false } = {}) {
    if (!CLASSES.includes(cls)) return { ok: false, error: `unknown class: ${cls}` }
    const node = this.cache.get(hostId)
    if (!node) return { ok: false, error: 'no such node' }
    const from = node.presence_class
    const saved = this.save({ ...node, presence_class: cls, confirmed: confirmed ? 1 : 0 })
    // Every write here is passphrase-gated and rare, which is exactly what makes
    // it worth an audit line (S3 §2): "谁把这台机器改成临时的" must be answerable
    // a day later, when the banner looks wrong and nobody remembers why.
    // `silent` is for the demo generator re-staging its own props on every
    // toggle - that is a mechanism, not something a user did (S3 §3).
    if (!silent) {
      recordEvent({ kind: 'roster', code: `class_${cls}`, hostId, level: 'info',
        detail: { from, to: cls } })
    }
    return { ok: true, node: saved }
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
    const saved = this.save({ ...node, settings_json: JSON.stringify(s) })
    recordEvent({ kind: 'roster', code: until === null ? 'unmuted' : 'muted', hostId,
      level: 'info', detail: { until: until === null ? null : until, until_text: untilText(until) } })
    return { ok: true, node: saved }
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

  setDisplay(hostId, name, { silent = false } = {}) {
    const node = this.cache.get(hostId)
    if (!node) return { ok: false, error: 'no such node' }
    const clean = String(name || '').trim().slice(0, 40)
    if (!clean) return { ok: false, error: 'empty name' }
    const from = node.display_name
    const saved = this.save({ ...node, display_name: clean })
    // Same `silent` rule as setClass, and the same reason: the demo generator
    // re-applies its own labels on every toggle (S3 §3).
    if (!silent && from !== clean) {
      recordEvent({ kind: 'roster', code: 'renamed', hostId, level: 'info',
        detail: { from, to: clean } })
    }
    return { ok: true, node: saved }
  }

  // ---------- meta key/value (admin passphrase, demo preference) ----------

  #metaGet(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null
  }

  #metaSet(key, value) {
    this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
  }

  /** The demo switch is a server-side preference: it must survive a restart. */
  setDemoEnabled(on) {
    const prev = this.demoEnabledStored()
    this.#metaSet('demo_enabled', on ? '1' : '0')
    // Only an actual change is a fleet fact; the endpoint is idempotent and a
    // re-assert of the current state must not add a line (S3 §3).
    if (prev !== !!on) {
      recordEvent({ kind: 'roster', code: on ? 'demo_on' : 'demo_off',
        hostId: null, level: 'info', detail: {} })
    }
  }
  demoEnabledStored() {
    const v = this.#metaGet('demo_enabled')
    return v === null ? null : v === '1'
  }

  // ---------- presence ledger (S5 §4) ----------
  //
  // Deliberately the *storage* half only: what counts as "present" is decided in
  // zerotier.js, and nothing in the four-state path (store.js / status.js /
  // alerts.js) may import any of it. A ZeroTier peer is a ledger row, not a node.

  static ZT_ADDR_RE = /^[0-9a-f]{10}$/

  presenceAliases() {
    const out = new Map()
    for (const r of this.db.prepare('SELECT * FROM presence_alias').all()) {
      out.set(r.zt_addr, r)
    }
    return out
  }

  /**
   * Bind a ZeroTier peer to a roster node (or just name it). `host_id: null`
   * clears the binding; with no binding and no label left, the row goes away.
   */
  setPresenceAlias(ztAddr, hostId = null, label = null, now = Date.now()) {
    const addr = String(ztAddr || '').trim().toLowerCase()
    if (!Roster.ZT_ADDR_RE.test(addr)) return { ok: false, error: 'ZT 地址格式不正确' }
    const hid = hostId ? String(hostId).trim() : null
    if (hid && !this.cache.has(hid)) return { ok: false, error: '名册里没有这个节点' }
    const lab = label ? String(label).trim().slice(0, 40) : null
    if (!hid && !lab) {
      this.db.prepare('DELETE FROM presence_alias WHERE zt_addr = ?').run(addr)
      return { ok: true, cleared: true }
    }
    this.db.prepare(`
      INSERT INTO presence_alias (zt_addr, host_id, label, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(zt_addr) DO UPDATE SET host_id=excluded.host_id,
        label=excluded.label, updated_at=excluded.updated_at`).run(addr, hid, lab, now)
    return { ok: true, alias: { zt_addr: addr, host_id: hid, label: lab } }
  }

  presenceStates() {
    return this.db.prepare('SELECT * FROM presence_state ORDER BY last_seen DESC').all()
  }

  /** Throttled per peer: the poll is 30s, the disk does not need every one. */
  notePresence({ ztAddr, name = null, latency = null }, now = Date.now()) {
    const addr = String(ztAddr || '').toLowerCase()
    if (!Roster.ZT_ADDR_RE.test(addr)) return false
    if (!this._presenceWrites) this._presenceWrites = new Map()
    const last = this._presenceWrites.get(addr) || 0
    if (now - last < PRESENCE_WRITE_MS) return false
    this._presenceWrites.set(addr, now)
    this.db.prepare(`
      INSERT INTO presence_state (zt_addr, name, first_seen, last_seen, last_latency)
      VALUES (?,?,?,?,?)
      ON CONFLICT(zt_addr) DO UPDATE SET name=excluded.name,
        last_seen=excluded.last_seen, last_latency=excluded.last_latency`)
      .run(addr, name, now, now, latency == null ? null : Math.round(latency))
    return true
  }

  // ---------- admin passphrase (S1 §5.2: default deny) ----------

  hasPassphrase() {
    return !!this.#metaGet('admin_pass')
  }

  setPassphrase(next, old) {
    if (typeof next !== 'string' || next.length < PASS_MIN_LEN) {
      return { ok: false, error: `口令至少 ${PASS_MIN_LEN} 位` }
    }
    if (this.hasPassphrase() && !this.checkPassphrase(old)) {
      return { ok: false, error: '原口令不正确' }
    }
    const wasSet = this.hasPassphrase()
    const salt = randomBytes(16).toString('hex')
    const hash = scryptSync(next, salt, 64).toString('hex')
    this.#metaSet('admin_pass', `scrypt$${salt}$${hash}`)
    // The fact "the admin passphrase changed" belongs in the audit stream; the
    // passphrase itself never goes anywhere near it (S3 §5, H11's transition rule).
    // Setting one for the first time is installation noise; replacing a live one is
    // the case somebody should look at, so only that one is amber.
    recordEvent({ kind: 'roster', code: 'passphrase_changed', hostId: null,
      level: wasSet ? 'warn' : 'info', detail: { was_set: wasSet } })
    return { ok: true }
  }

  checkPassphrase(pass) {
    if (typeof pass !== 'string' || !pass) return false
    const stored = this.#metaGet('admin_pass')
    if (!stored) return false
    const [scheme, salt, hash] = String(stored).split('$')
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
