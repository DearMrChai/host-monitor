/**
 * Alert engine (P2): debounced alert lifecycle over instantaneous
 * status.js evaluations. Contract in P2-细化设计.md §1/§2.
 *
 * Rules:
 *  - merge key = host_id|metric|source (one alert per key)
 *  - trigger after `debounce_cycles` consecutive ticks over threshold
 *    (offline bypasses the window and fires immediately)
 *  - escalation is immediate; de-escalation/recovery uses the same window
 *  - an alert only "recovers" when its host is reporting and the reason is
 *    gone: reclassifying/retiring closes it as `cancelled`, a host the Server
 *    has no data for holds it (see unknownGraceMs()) - never a fake 已恢复
 *  - resolved alerts are kept `resolved_keep_minutes`, capped at history_capacity
 *  - host.status.level becomes the DEBOUNCED level; instant level moves to
 *    host.status.instant_level; in-window suspects appear in host.status.pending
 */
import { thresholds } from './config.js'
import { history } from './history.js'
import { roster } from './roster.js'

// Read per tick, never frozen at import (S6 §2.1 / J1): a `const` here would be a
// second runtime truth that the settings screen cannot reach, which is the exact
// shape of H9. Missing keys keep the documented defaults.
const alertCfg = () => thresholds.alert || {}
const debounceCycles = () => alertCfg().debounce_cycles ?? 3
const keepMs = () => (alertCfg().resolved_keep_minutes ?? 5) * 60_000
const historyCapacity = () => alertCfg().history_capacity ?? 200
const tickMs = () => alertCfg().tick_ms ?? 2000
// How long an alert may stay "frozen because its host is unknown to this
// Server process" before it closes as stale instead of pinning the banner.
// Agents reconnect within seconds after a restart, so this only has to cover
// the reconnect window - keep it short, because a frozen CRIT keeps the client
// crit loop running and a powered-off machine must not howl for half an hour.
const unknownGraceMs = () => (alertCfg().unknown_alert_grace_minutes ?? 5) * 60_000

const RANK = { OK: 0, WARN: 1, CRIT: 2, OFFLINE: 3 }

/* Exported as well as instantiated: the restart window (H14) is only testable
   against a clock the test controls, and `advance(hosts, now)` is the half that
   takes one - the singleton below is driven by wall time from the server loop. */
export class AlertEngine {
  constructor() {
    /** @type {Map<string, object>} key -> entry */
    this.entries = new Map()
    this.lastTickAt = 0
  }

  /**
   * Advance windows at most once per tickMs() (idempotent for REST polls),
   * then annotate every host.status with debounced fields.
   */
  tick(hosts) {
    const now = Date.now()
    // Recomputed on EVERY call, not only on gated ticks: a mute the user just
    // set must show up in the next snapshot (<1ms), not up to tickMs() later.
    this.muted = this.muteSet(hosts, now)
    if (now - this.lastTickAt >= tickMs()) {
      this.lastTickAt = now
      this.advance(hosts, now)
    }
    this.apply(hosts)
  }

  /** S1 §3.3: a muted node's thresholds are neither evaluated nor resolved -
   *  the alert freezes where it was instead of faking a recovery. OFFLINE is
   *  exempt from muting (availability is worth waking up for).
   *  Derived from the roster, NOT from `hosts`: a muted node that is momentarily
   *  missing from the store (Server restarted, Agent has not reconnected) must
   *  still count as muted, or its frozen alert ages out into a fake recovery. */
  muteSet(_hosts, now = Date.now()) {
    return new Set(roster.mutedIds(now))
  }

  advance(hosts, now) {
    const seen = new Set()
    const muted = this.muted = this.muteSet(hosts, now)
    // Hosts the Server has *any* record of in this process. Absent from this
    // set means "we know nothing", not "it got healthy" - see the freeze below.
    const known = new Set(hosts.map((h) => h.host_id))
    // S3b: the subset of those records that are synthesised absences. They are
    // `known` (so they do not age out as stale) but they yield no reasons (so
    // they must not read as a recovery either) - they get their own closure.
    const absent = new Set(hosts.filter((h) => h.absent_record).map((h) => h.host_id))

    for (const host of hosts) {
      for (const r of host.status?.reasons || []) {
        if (muted.has(host.host_id) && r.metric !== 'offline') continue
        const key = `${host.host_id}|${r.metric}|${r.source}`
        seen.add(key)
        let e = this.entries.get(key)

        if (!e || e.state === 'resolved') {
          e = {
            id: key, host_id: host.host_id, hostname: host.hostname,
            metric: r.metric, source: r.source, level: r.level,
            state: 'pending', overCycles: 1, underCycles: 0,
            value_at_trigger: r.value, latest_value: r.value, threshold: r.threshold,
            custom: r.custom,
            started_at: null, resolved_at: null,
          }
          this.entries.set(key, e)
          if (r.metric === 'offline') this.activate(e, r, now)
        } else if (e.state === 'pending') {
          e.overCycles += 1
          // `threshold`/`custom` travel with `latest_value`: both describe the
          // comparison happening *now*, and an owner can move their own red line
          // while an alert is still in its window (S6 J3).
          e.latest_value = r.value
          e.threshold = r.threshold
          e.custom = r.custom
          if (RANK[r.level] > RANK[e.level]) e.level = r.level
          if (e.metric === 'offline' || e.overCycles >= debounceCycles()) this.activate(e, r, now)
        } else { // active
          e.latest_value = r.value
          // A node whose owner raised the crit line mid-alert must not keep
          // showing the line it crossed an hour ago, and the "该机自定义" tag
          // has to survive the debouncer or it never reaches the card (J3).
          e.threshold = r.threshold
          e.custom = r.custom
          e.underCycles = 0
          e._unknownSince = null // reporting again: the no-news clock restarts
          const escalated = RANK[r.level] > RANK[e.level]
          if (escalated) e.level = r.level // escalate immediately
          if (escalated || now - (e._persistedAt || 0) >= 10_000) persist(e)
        }
      }
    }

    for (const [key, e] of this.entries) {
      if (seen.has(key)) continue
      // Muted host: leave active entries as they are (frozen, hidden by
      // getLists) and do not age out pending ones.
      if (muted.has(e.host_id)) continue
      if (e.state === 'pending') {
        this.entries.delete(key) // window broken before firing
      } else if (e.state === 'active') {
        /* S1b: leaving the alarming population is not a recovery. When a node
           is reclassified (临时) or retired while its alert is open, close it
           as cancelled - ageing it into "已恢复" would tell the user the
           machine came back, which is the opposite of what happened.
           S3b adds one more way out: a persistent node that turns into an
           absent_record stops yielding reasons, and the OLD path resolved its
           失联 alert as "回到阈值内（204）" — with the node 204 seconds stale, that
           is the same lie in a new costume. It closes as 改判缺席 instead. */
        const cls = roster.classOf(e.host_id)
        const cancelledBy = cls === 'retired' ? 'retired'
          : absent.has(e.host_id) ? 'absent'
          : (cls === 'ephemeral' && e.metric === 'offline') ? 'reclassified' : null
        if (cancelledBy) {
          e.state = 'resolved'
          e.cancelled = cancelledBy
          e.resolved_at = Date.now()
          persist(e)
        } else if (!known.has(e.host_id)) {
          /* S1b defect 9: the Server has no record of this host at all in this
             process - the window after a restart, before the Agents reconnect,
             while restoreActive() has already put yesterday's alerts back.
             Ageing here would print 已恢复 for a machine we have no data about,
             so the entry holds. Bounded: a node that never returns must not pin
             an alert forever, so after the grace it closes as 已失效, never 已恢复. */
          e._unknownSince ??= now
          if (now - e._unknownSince >= unknownGraceMs()) {
            e.state = 'resolved'
            e.cancelled = 'stale'
            e.resolved_at = now
            persist(e)
          }
        } else {
          e._unknownSince = null
          e.underCycles += 1
          if (e.underCycles >= debounceCycles()) {
            e.state = 'resolved'
            e.resolved_at = Date.now()
            persist(e)
          }
        }
      } else if (Date.now() - e.resolved_at > keepMs()) {
        this.entries.delete(key)
      }
    }

    // Trim history to capacity (oldest resolved first)
    const resolved = [...this.entries.values()].filter((e) => e.state === 'resolved')
    if (resolved.length > historyCapacity()) {
      resolved.sort((a, b) => a.resolved_at - b.resolved_at)
      for (const e of resolved.slice(0, resolved.length - historyCapacity())) {
        this.entries.delete(e.id)
      }
    }
  }

  activate(e, r, now) {
    e.state = 'active'
    e.started_at = now
    e.value_at_trigger = r.value
    e.threshold = r.threshold
    e.custom = r.custom
    e.underCycles = 0
    persist(e)
  }

  /** P5: rebuild active entries persisted before a restart (design §7). */
  restoreActive(rows) {
    const now = Date.now()
    let n = 0
    for (const r of rows) {
      if (this.entries.has(r.id)) continue
      this.entries.set(r.id, {
        id: r.id, host_id: r.host_id, hostname: r.hostname,
        metric: r.metric, source: r.source, level: r.level,
        state: 'active', overCycles: debounceCycles(),
        underCycles: debounceCycles() - 1, // self-heals within 2 clean ticks
        value_at_trigger: r.value_at_trigger, latest_value: r.latest_value,
        threshold: r.threshold, started_at: r.started_at, resolved_at: null,
        // H14: freeze it the moment it is restored, rather than letting the first
        // tick notice. A row read back from disk is by definition a claim this
        // process cannot yet back up with data - the Agent has not reconnected -
        // and the gap between "snapshot served" and "first advance()" is exactly
        // where a restart used to start the client's crit loop on its own.
        _unknownSince: now,
      })
      n += 1
    }
    if (n) console.log(`[Alerts] Restored ${n} active alert(s) from disk`)
  }

  apply(hosts) {
    const byHost = new Map()
    const muted = this.muted || new Set()
    for (const e of this.entries.values()) {
      if (e.state === 'resolved') continue
      if (!byHost.has(e.host_id)) byHost.set(e.host_id, [])
      byHost.get(e.host_id).push(e)
    }

    for (const host of hosts) {
      const s = host.status
      if (!s) continue
      s.instant_level = s.level
      s.muted = muted.has(host.host_id)
      const entries = byHost.get(host.host_id) || []
      const active = entries.filter((e) => e.state === 'active')
      const pending = entries.filter((e) => e.state === 'pending')

      let debounced = null
      for (const e of active) {
        if (!debounced || RANK[e.level] > RANK[debounced]) debounced = e.level
      }
      // Offline is not debounced (it fires immediately), and an ephemeral node
      // deliberately produces no offline reason - so its level must pass
      // through from the instant evaluation instead of collapsing to OK.
      s.level = host.online ? (debounced || 'OK') : (s.instant_level || 'OFFLINE')

      s.reasons = active.map((e) => ({
        metric: e.metric, source: e.source, value: e.latest_value,
        threshold: e.threshold, level: e.level,
        ...(e.custom ? { custom: true } : {}),
      }))
      s.pending = pending.map((e) => ({
        metric: e.metric, source: e.source, value: e.latest_value,
        level: e.level, cycles: e.overCycles, needed: debounceCycles(),
        ...(e.custom ? { custom: true } : {}),
      }))
    }
  }

  getLists() {
    const muted = this.muted || new Set()
    const active = []
    const resolved = []
    for (const e of this.entries.values()) {
      if (e.state === 'pending') continue
      // Hidden from banner / list / sound while the node is muted; the state
      // machine itself kept running untouched, so unmuting shows the truth.
      if (muted.has(e.host_id) && e.metric !== 'offline') continue
      // H14: `frozen` is the Server admitting that it is holding this alert
      // because it has *no* record of the host in this process - not because
      // fresh data says the machine is breaching. It stays on the board (the
      // box may well be on fire, and the alternative is deleting an open alert
      // because we lost sight of it), but the client must not make noise over
      // it, and after the grace it closes as 已失效.
      const frozen = e.state === 'active' && e._unknownSince != null
      const a = {
        id: e.id, host_id: e.host_id, hostname: e.hostname,
        // Banner/list must call the node what the card calls it (S1b).
        display_name: roster.get(e.host_id)?.display_name || e.hostname,
        metric: e.metric, source: e.source, level: e.level, state: e.state,
        value_at_trigger: e.value_at_trigger, latest_value: e.latest_value,
        threshold: e.threshold, started_at: e.started_at, resolved_at: e.resolved_at,
        // Omitted rather than set to `undefined`, and in one spread: a row that
        // *carries* `frozen: undefined` reads as "not frozen" everywhere it is
        // displayed but fails `'frozen' in row` for the next person, and JSON
        // drops the key on the wire so the two views would disagree (G8).
        // The alert list is where a friend's tuned box is most likely to be
        // misread as a fleet-wide breach, so the tag has to survive here too (J3).
        ...(e.custom === true ? { custom: true } : {}),
        ...(frozen ? { frozen: true, frozen_since: e._unknownSince } : {}),
        // 'reclassified' | 'retired' | 'stale' | null - how an alert ended,
        // when it was not a recovery (S1b). The UI must not print 已恢复 for
        // any of them; each reason has its own wording in resolvedText().
        cancelled: e.cancelled || null,
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
