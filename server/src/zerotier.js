/**
 * ZeroTier presence ledger (S5 §4): which machines are currently inside my
 * overlay - without them running an Agent, without the Server holding a single
 * credential for them.
 *
 * Why this exists: the fleet outgrew "three boxes I own" (V2 decision 1), and the
 * honest answer to "is the office 35B there?" cannot be an Agent I am not allowed
 * to install on someone else's machine. ZeroTier already knows - it has a live
 * peer list with latencies. So we read that list from the local API of the box
 * the Server runs on: zero install on the target, zero credentials handed over,
 * works across physical networks.
 *
 * Two hard constraints from 纪要 §2.6, enforced structurally rather than by
 * discipline:
 *  1. A peer is a **ledger row**, never a node. This module imports the roster to
 *     resolve names and nothing else - not store.js, not status.js, not alerts.js.
 *     A presence row therefore cannot reach the four-state merge, the health
 *     roll-up, the alert engine or the sound, and it is absent from /api/hosts.
 *  2. Reading is open, writing (the alias bindings) is behind the admin
 *     passphrase, and the ZeroTier API token never leaves this process - it is
 *     not returned by any endpoint and not written to any log line.
 *
 * Failure stance: an unreadable ZeroTier API is a *degraded source*, not an
 * incident. No alert, no banner, no four-state colour - the card says the source
 * is unavailable and keeps showing whatever it last saw.
 */
import { readFileSync, existsSync } from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { roster } from './roster.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PORT = 9993

/** Where the desktop app keeps its API token, per platform. */
function defaultTokenFile() {
  return os.platform() === 'win32'
    ? path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'ZeroTier', 'One', 'authtoken.secret')
    : '/var/lib/zerotier-one/authtoken.secret'
}

/** The whole shape is always returned, defaults included: `setEndpoint` and a
 *  later re-enable both read fields off this object, and a disabled branch that
 *  forgot `timeout_ms` would abort every poll (caught by the self-test, which
 *  starts from exactly this no-config shape). */
function loadCfg() {
  const p = process.env.HM_ZT_CONFIG || path.join(__dirname, 'config', 'zt.json')
  let raw = null
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    raw = null   // no file / unreadable / not JSON -> the ledger is simply off
  }
  const poll = Math.min(Math.max(Number(raw?.poll_seconds) || 30, 5), 600)
  return {
    enabled: raw ? raw.enabled !== false : false,
    reason: raw ? (raw.enabled === false ? 'disabled' : null) : 'no-config',
    path: p,
    poll_seconds: poll,
    api_port: Number(raw?.api_port) || DEFAULT_PORT,
    token_file: raw?.token_file || defaultTokenFile(),
    // Peers to drop before anything else: root servers and planets answer pings
    // too, and listing them as "在场设备" would be a lie by category.
    exclude: Array.isArray(raw?.exclude) ? raw.exclude.map((s) => String(s).toLowerCase()) : [],
    timeout_ms: Math.min(Math.max(Number(raw?.timeout_ms) || 4_000, 500), 20_000),
  }
}

class ZeroTierPresence {
  constructor() {
    this.cfg = loadCfg()
    /** @type {Map<string, object>} live peers from the last successful poll */
    this.live = new Map()
    this.sourceOk = false
    this.lastPollAt = 0
    this.lastOkAt = 0
    this.lastError = null
    this.polls = 0
    this.timer = null
    if (!this.cfg.enabled) {
      console.log('[Presence] ZeroTier ledger off (no zt.json or enabled:false)')
    } else {
      console.log(`[Presence] ZeroTier ledger on: 127.0.0.1:${this.cfg.api_port}, poll ${this.cfg.poll_seconds}s`)
    }
  }

  /** Started from index.js, like demoFleet. Off means no timer at all. */
  start() {
    if (!this.cfg.enabled || this.timer) return
    this.poll().catch(() => {})
    this.timer = setInterval(() => this.poll().catch(() => {}), this.cfg.poll_seconds * 1000)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  #token() {
    if (process.env.HM_ZT_TOKEN) return String(process.env.HM_ZT_TOKEN).trim()
    try {
      return readFileSync(this.cfg.token_file, 'utf8').trim()
    } catch {
      return null
    }
  }

  /** One read of the local API. Never throws; failures land in `lastError`. */
  async poll() {
    const token = this.#token()
    this.polls += 1
    this.lastPollAt = Date.now()
    if (!token) return this.#fail('token-unreadable')
    try {
      const res = await fetch(`http://127.0.0.1:${this.cfg.api_port}/getPeers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token },
        body: '{}',
        signal: AbortSignal.timeout(this.cfg.timeout_ms),
      })
      if (!res.ok) return this.#fail(`http-${res.status}`)
      const peers = await res.json()
      if (!Array.isArray(peers)) return this.#fail('bad-shape')
      this.#ingest(peers)
      this.sourceOk = true
      this.lastError = null
      this.lastOkAt = Date.now()
    } catch (err) {
      // Only the class of failure: an exception message can carry a URL, and a
      // stack never goes anywhere near a log we ship (S5 G3).
      this.#fail(err?.name === 'TimeoutError' ? 'timeout' : 'unreachable')
    }
  }

  #fail(kind) {
    // One line per state change, not one per poll: a box without ZeroTier must
    // not add a 30s heartbeat of noise to server.log.
    const changed = this.sourceOk || this.lastError !== kind
    this.sourceOk = false
    this.lastError = kind
    if (changed) console.log(`[Presence] ZeroTier source unavailable (${kind})`)
  }

  /** Reachable == ZeroTier has a live path with measured latency (-1 = unknown). */
  #ingest(peers) {
    const now = Date.now()
    const next = new Map()
    for (const p of peers) {
      const addr = String(p.address || '').toLowerCase()
      if (!/^[0-9a-f]{10}$/.test(addr)) continue
      if (p.localPeer) continue
      if (this.cfg.exclude.some((x) => addr.startsWith(x))) continue
      const lat = Number(p.latency)
      const reachable = Number.isFinite(lat) && lat >= 0
      const name = p.name ? String(p.name).slice(0, 48) : null
      next.set(addr, {
        zt_addr: addr, name, reachable,
        latency_ms: reachable ? Math.round(lat) : null,
        version: p.version ? String(p.version).slice(0, 16) : null,
        last_seen: reachable ? now : null,
      })
      if (reachable) roster.notePresence({ ztAddr: addr, name, latency: lat }, now)
    }
    this.live = next
  }

  /** hostname -> host_id, for peers that name themselves the way the Agent does. */
  #nameIndex() {
    const by = new Map()
    for (const n of roster.active()) {
      if (n.kind === 'demo' || !n.hostname) continue
      const key = String(n.hostname).toLowerCase()
      if (by.has(key)) by.set(key, null) // ambiguous: never guess (S5 §4.2)
      else by.set(key, n.host_id)
    }
    return by
  }

  /** The ledger: live peers plus persisted rows nobody sees any more. */
  info() {
    const aliases = roster.presenceAliases()
    const byName = this.#nameIndex()
    const stored = new Map(roster.presenceStates().map((s) => [s.zt_addr, s]))
    const rows = []
    const push = (row) => {
      const alias = aliases.get(row.zt_addr)
      const auto = !alias && row.name ? byName.get(row.name.toLowerCase()) : undefined
      const hostId = alias?.host_id || auto || null
      const node = hostId ? roster.get(hostId) : null
      rows.push({
        ...row,
        host_id: hostId,
        display_name: node?.display_name || null,
        label: alias?.label || null,
        matched_by: alias?.host_id ? 'alias' : auto ? 'name' : null,
        ambiguous: !alias?.host_id && !!row.name && auto === null,
      })
    }
    for (const peer of this.live.values()) {
      const kept = stored.get(peer.zt_addr)
      push({ ...peer, first_seen: kept?.first_seen ?? peer.last_seen })
    }
    // Rows the ledger remembers but this poll did not see: "it was here at
    // 23:10" is the actual question a ledger answers (S5 §4.2).
    for (const s of stored.values()) {
      if (this.live.has(s.zt_addr)) continue
      push({
        zt_addr: s.zt_addr, name: s.name, reachable: false, latency_ms: null,
        version: null, last_seen: s.last_seen, first_seen: s.first_seen, remembered: true,
      })
    }
    rows.sort((a, b) => (b.reachable - a.reachable) || ((b.last_seen || 0) - (a.last_seen || 0)))
    return {
      enabled: this.cfg.enabled,
      reason: this.cfg.enabled ? null : this.cfg.reason,
      source_ok: this.sourceOk,
      error: this.lastError,
      poll_seconds: this.cfg.poll_seconds,
      last_poll_at: this.lastPollAt || null,
      last_ok_at: this.lastOkAt || null,
      peers: rows,
      counts: {
        visible: rows.length,
        present: rows.filter((r) => r.reachable).length,
        named: rows.filter((r) => r.host_id || r.label).length,
      },
    }
  }

  /** Self-test hook: point at a throwaway API without touching a config file. */
  setEndpoint({ port, token, pollSeconds } = {}) {
    if (Number.isFinite(Number(port))) this.cfg.api_port = Number(port)
    if (typeof token === 'string') {
      this.cfg.token_file = ''
      process.env.HM_ZT_TOKEN = token
    }
    if (Number.isFinite(Number(pollSeconds))) this.cfg.poll_seconds = Number(pollSeconds)
    this.cfg.enabled = true
    this.cfg.reason = null
    return this.cfg
  }
}

export const ztPresence = new ZeroTierPresence()
