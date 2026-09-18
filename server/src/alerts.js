/**
 * Alert engine (P2): debounced alert lifecycle over instantaneous
 * status.js evaluations. Contract in P2-细化设计.md §1/§2.
 *
 * Rules:
 *  - merge key = host_id|metric|source (one alert per key)
 *  - trigger after `debounce_cycles` consecutive ticks over threshold
 *    (offline bypasses the window and fires immediately)
 *  - escalation is immediate; de-escalation/recovery uses the same window
 *  - resolved alerts are kept `resolved_keep_minutes`, capped at history_capacity
 *  - host.status.level becomes the DEBOUNCED level; instant level moves to
 *    host.status.instant_level; in-window suspects appear in host.status.pending
 */
import { thresholds } from './status.js'
import { history } from './history.js'

const cfg = thresholds.alert || {}
const DEBOUNCE_CYCLES = cfg.debounce_cycles ?? 3
const KEEP_MS = (cfg.resolved_keep_minutes ?? 5) * 60_000
const HISTORY_CAPACITY = cfg.history_capacity ?? 200
const TICK_MS = cfg.tick_ms ?? 2000

const RANK = { OK: 0, WARN: 1, CRIT: 2, OFFLINE: 3 }

class AlertEngine {
  constructor() {
    /** @type {Map<string, object>} key -> entry */
    this.entries = new Map()
    this.lastTickAt = 0
  }

  /**
   * Advance windows at most once per TICK_MS (idempotent for REST polls),
   * then annotate every host.status with debounced fields.
   */
  tick(hosts) {
    const now = Date.now()
    if (now - this.lastTickAt >= TICK_MS) {
      this.lastTickAt = now
      this.advance(hosts, now)
    }
    this.apply(hosts)
  }

  advance(hosts, now) {
    const seen = new Set()

    for (const host of hosts) {
      for (const r of host.status?.reasons || []) {
        const key = `${host.host_id}|${r.metric}|${r.source}`
        seen.add(key)
        let e = this.entries.get(key)

        if (!e || e.state === 'resolved') {
          e = {
            id: key, host_id: host.host_id, hostname: host.hostname,
            metric: r.metric, source: r.source, level: r.level,
            state: 'pending', overCycles: 1, underCycles: 0,
            value_at_trigger: r.value, latest_value: r.value, threshold: r.threshold,
            started_at: null, resolved_at: null,
          }
          this.entries.set(key, e)
          if (r.metric === 'offline') this.activate(e, r, now)
        } else if (e.state === 'pending') {
          e.overCycles += 1
          e.latest_value = r.value
          if (RANK[r.level] > RANK[e.level]) e.level = r.level
          if (e.metric === 'offline' || e.overCycles >= DEBOUNCE_CYCLES) this.activate(e, r, now)
        } else { // active
          e.latest_value = r.value
          e.underCycles = 0
          const escalated = RANK[r.level] > RANK[e.level]
          if (escalated) e.level = r.level // escalate immediately
          if (escalated || now - (e._persistedAt || 0) >= 10_000) persist(e)
        }
      }
    }

    for (const [key, e] of this.entries) {
      if (seen.has(key)) continue
      if (e.state === 'pending') {
        this.entries.delete(key) // window broken before firing
      } else if (e.state === 'active') {
        e.underCycles += 1
        if (e.underCycles >= DEBOUNCE_CYCLES) {
          e.state = 'resolved'
          e.resolved_at = Date.now()
          persist(e)
        }
      } else if (Date.now() - e.resolved_at > KEEP_MS) {
        this.entries.delete(key)
      }
    }

    // Trim history to capacity (oldest resolved first)
    const resolved = [...this.entries.values()].filter((e) => e.state === 'resolved')
    if (resolved.length > HISTORY_CAPACITY) {
      resolved.sort((a, b) => a.resolved_at - b.resolved_at)
      for (const e of resolved.slice(0, resolved.length - HISTORY_CAPACITY)) {
        this.entries.delete(e.id)
      }
    }
  }

  activate(e, r, now) {
    e.state = 'active'
    e.started_at = now
    e.value_at_trigger = r.value
    e.threshold = r.threshold
    e.underCycles = 0
    persist(e)
  }

  /** P5: rebuild active entries persisted before a restart (design §7). */
  restoreActive(rows) {
    let n = 0
    for (const r of rows) {
      if (this.entries.has(r.id)) continue
      this.entries.set(r.id, {
        id: r.id, host_id: r.host_id, hostname: r.hostname,
        metric: r.metric, source: r.source, level: r.level,
        state: 'active', overCycles: DEBOUNCE_CYCLES,
        underCycles: DEBOUNCE_CYCLES - 1, // self-heals within 2 clean ticks
        value_at_trigger: r.value_at_trigger, latest_value: r.latest_value,
        threshold: r.threshold, started_at: r.started_at, resolved_at: null,
      })
      n += 1
    }
    if (n) console.log(`[Alerts] Restored ${n} active alert(s) from disk`)
  }

  apply(hosts) {
    const byHost = new Map()
    for (const e of this.entries.values()) {
      if (e.state === 'resolved') continue
      if (!byHost.has(e.host_id)) byHost.set(e.host_id, [])
      byHost.get(e.host_id).push(e)
    }

    for (const host of hosts) {
      const s = host.status
      if (!s) continue
      s.instant_level = s.level
      const entries = byHost.get(host.host_id) || []
      const active = entries.filter((e) => e.state === 'active')
      const pending = entries.filter((e) => e.state === 'pending')

      let debounced = null
      for (const e of active) {
        if (!debounced || RANK[e.level] > RANK[debounced]) debounced = e.level
      }
      s.level = debounced || 'OK'

      s.reasons = active.map((e) => ({
        metric: e.metric, source: e.source, value: e.latest_value,
        threshold: e.threshold, level: e.level,
      }))
      s.pending = pending.map((e) => ({
        metric: e.metric, source: e.source, value: e.latest_value,
        level: e.level, cycles: e.overCycles, needed: DEBOUNCE_CYCLES,
      }))
    }
  }

  getLists() {
    const active = []
    const resolved = []
    for (const e of this.entries.values()) {
      if (e.state === 'pending') continue // pending is exposed via host.status.pending only
      const a = {
        id: e.id, host_id: e.host_id, hostname: e.hostname,
        metric: e.metric, source: e.source, level: e.level, state: e.state,
        value_at_trigger: e.value_at_trigger, latest_value: e.latest_value,
        threshold: e.threshold, started_at: e.started_at, resolved_at: e.resolved_at,
      }
      if (e.state === 'resolved') resolved.push(a)
      else active.push(a)
    }
    active.sort((x, y) => RANK[y.level] - RANK[x.level] || x.started_at - y.started_at)
    resolved.sort((x, y) => y.resolved_at - x.resolved_at)
    return { active, resolved }
  }
}

function persist(e) {
  e._persistedAt = Date.now()
  history.recordAlert(e)
}

export const alertEngine = new AlertEngine()
