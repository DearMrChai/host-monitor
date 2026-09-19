/**
 * In-memory data store for host monitoring.
 * Tracks connected hosts, their topology, latest metrics, and online status.
 */
import { evaluateHost, evaluateCluster, thresholds } from './status.js';
import { alertEngine } from './alerts.js';
import { roster } from './roster.js';
import { ingest } from './ingest.js';
import { demoFleet } from './demo.js';
import { record as recordEvent, oncePerEpisode } from './events.js';

const OFFLINE_TIMEOUT_MS = 15_000;

/** Presence policy (S3 §4.1). `confirmed` + this grace window are what keep the
 *  roster-derived absence cards from becoming the new ghost nodes: nothing is
 *  declared absent while its Agent could still be mid-reconnect after a restart. */
function presenceCfg() {
  const p = thresholds.presence || {};
  return {
    enabled: p.enabled !== false,
    absentAfterMs: (Number(p.absent_after_minutes) || 3) * 60_000,
    // Two thresholds, two different questions (H18). `absent_after_minutes`
    // asks "has this node been missing longer than a restart window" - it is
    // about the roster rows this process never saw. `degrade_after_minutes`
    // asks "how long do I keep shouting about a machine I watched go quiet".
    degradeAfterMs: (Number(p.degrade_after_minutes) || 15) * 60_000,
  };
}

class MonitorStore {
  constructor() {
    /** @type {Map<string, HostRecord>} */
    this.hosts = new Map();
  }

  /**
   * Register or update a host (now includes topology).
   * The roster is the source of truth for how a node is *classified*; this
   * store only holds what the Agent is reporting right now (S1 §2).
   */
  register(hostId, info = {}) {
    roster.ensure(hostId, info);
    const existing = this.hosts.get(hostId);
    if (existing) {
      existing.hostname = info.hostname || existing.hostname;
      existing.platform = info.platform || existing.platform;
      if (info.role) existing.role = info.role;
      if (info.topology) existing.topology = info.topology;
      existing.lastSeen = Date.now();
      existing.online = true;
    } else {
      this.hosts.set(hostId, {
        host_id: hostId,
        hostname: info.hostname || hostId,
        platform: info.platform || 'unknown',
        role: info.role || 'other',
        topology: info.topology || null,
        online: true,
        lastSeen: Date.now(),
        registeredAt: Date.now(),
        metrics: null,
      });
    }
    return this.hosts.get(hostId);
  }

  /**
   * Update metrics for a host.
   */
  updateMetrics(hostId, metrics) {
    let host = this.hosts.get(hostId);
    if (!host) {
      this.register(hostId, {
        hostname: metrics.hostname,
        platform: metrics.platform,
      });
      host = this.hosts.get(hostId);
    }
    host.metrics = metrics;
    host.lastSeen = Date.now();
    host.online = true;
    roster.markSeen(hostId, host.lastSeen);
  }

  markDisconnected(hostId) {
    const host = this.hosts.get(hostId);
    if (host) host.online = false;
  }

  checkTimeouts(now = Date.now()) {
    const { degradeAfterMs } = presenceCfg();
    for (const [, host] of this.hosts) {
      const silent = now - host.lastSeen;
      if (host.online && silent > OFFLINE_TIMEOUT_MS) host.online = false;
      /* H18: a machine that went quiet *while this process was running* used to
         stay a live OFFLINE record forever, because `hosts` is never pruned - so
         shutting a box down overnight meant a CRIT card, a looping sound and a
         hit to the health roll-up for a machine that simply stopped being here.
         Past the degrade window it becomes an absence record, i.e. it takes the
         exact path S3 §4.2 already built: no reasons, alert closed as
         `cancelled='absent'`, out of health, still in the online denominator.
         Not removed from the table: "3 常驻，现在在 1 台" must stay true. */
      const degrade = silent > degradeAfterMs && this.#degradable(host);
      if (degrade && !host.absent_record) {
        host.absent_record = true;
        host.absent_by = 'silence';
      } else if (!degrade && host.absent_record && host.absent_by === 'silence') {
        host.absent_record = false;
        host.absent_by = null;
      }
    }
  }

  /** Only a node a human vouched for can be re-judged as absent (H18): an
   *  unconfirmed arrival or a demo prop going quiet says nothing about the fleet. */
  #degradable(host) {
    const node = roster.get(host.host_id);
    if (!node || !node.confirmed) return false;
    if (node.presence_class !== 'persistent') return false;
    if (node.kind !== 'agent') return false;
    return true;
  }

  getAllHosts() {
    return Array.from(this.hosts.values());
  }

  /**
   * Annotated hosts: roster facts attached, instant four-state, then debounced
   * by the alert engine. Retired nodes are filtered out here so they leave the
   * dashboard, every aggregate and the alert path in one stroke - their rows
   * stay in the store (and their history stays queryable by host_id).
   *
   * S3 §4.1 (H12): the list is **roster-driven**, not "whatever reconnected
   * since this process started". A confirmed node that is in the roster but not
   * in the live host table is synthesized as an absence record, so it is in the
   * `在线 n/m` denominator, gets a grey card with its last-known time, and shows
   * up in the event stream - instead of vanishing, which was the exact case the
   * board most needed to speak up about (machine moved / reinstalled / left off).
   */
  getAnnotatedHosts() {
    const now = Date.now();
    this.checkTimeouts();
    const hosts = this.getAllHosts()
      .filter((h) => roster.classOf(h.host_id) !== 'retired');
    hosts.push(...this.#absenceRecords(hosts, now));
    for (const host of hosts) {
      const node = roster.get(host.host_id);
      if (node) {
        host.display_name = node.display_name;
        host.presence_class = node.presence_class;
        host.owner = node.owner;
        host.site = node.site;
        host.kind = node.kind;
        host.confirmed = !!node.confirmed;
        host.agent_version = node.agent_version;
        // The ABSENT card says "last present HH:MM"; that must be the roster's
        // persisted value, not host.lastSeen (which resets on a Server restart).
        host.last_seen = node.last_seen;
      } else {
        host.presence_class = 'persistent';
        host.display_name = host.hostname;
        host.confirmed = false;
      }
      host.muted_until = roster.mutedUntil(host.host_id);
      host.status = evaluateHost(host);
    }
    this.#presenceEvents(hosts);
    alertEngine.tick(hosts);
    return hosts;
  }

  /** Confirmed roster nodes the live table has not seen since a restart (H12). */
  #absenceRecords(liveHosts, now) {
    const { enabled, absentAfterMs } = presenceCfg();
    if (!enabled) return [];
    const live = new Set(liveHosts.map((h) => h.host_id));
    const out = [];
    for (const node of roster.active()) {
      if (live.has(node.host_id)) continue;
      // Only a human (or a pairing) ever said "this machine stays here". The
      // history seed brings back every host_id that ever reported, dev mocks
      // included - those are not anybody's claim and must not nag.
      if (!node.confirmed) continue;
      // Props are generated in this process; "the prop is absent" says nothing
      // about the fleet and would be a lie by category (S2 §5).
      if (node.kind === 'demo') continue;
      const last = Number(node.last_seen) || 0;
      if (!last || now - last < absentAfterMs) continue;
      out.push({
        host_id: node.host_id,
        hostname: node.hostname || node.host_id,
        platform: 'unknown',
        role: node.role || 'other',
        topology: null,
        metrics: null,
        online: false,
        lastSeen: last,
        last_seen: last,
        registeredAt: last,
        absent_record: true,
        // Which of the two absences this is: the card wording differs (S5 §5.1).
        absent_by: 'restart',
      });
    }
    return out;
  }

  /**
   * Presence facts for the 24h stream (S3 §3). Deliberately narrow:
   *  - the first pass after a start only baselines, so a restart produces no
   *    "everything came online" storm;
   *  - only *returning* is announced for every class; a persistent node *leaving*
   *    is already an OFFLINE alert row in `alert_events` (one fact, one source -
   *    S3 §2), while an ephemeral one generates no alert, so it is recorded here;
   *  - absence is announced once per episode, and the DB window makes that hold
   *    across restarts.
   */
  #presenceEvents(hosts) {
    if (!this._presenceSeen) {
      this._presenceSeen = new Map(hosts.map((h) => [h.host_id, !!h.online]));
      return;
    }
    for (const h of hosts) {
      const was = this._presenceSeen.get(h.host_id);
      const is = !!h.online;
      this._presenceSeen.set(h.host_id, is);
      if (was === undefined || was === is) continue;
      if (is) {
        recordEvent({ kind: 'presence', code: 'came_online', hostId: h.host_id,
          level: 'info', detail: { was_absent_record: !!h.absent_record } });
      } else if (h.presence_class === 'ephemeral') {
        recordEvent({ kind: 'presence', code: 'went_offline', hostId: h.host_id,
          level: 'info', detail: {} });
      }
    }
    for (const h of hosts) {
      if (!h.absent_record) continue;
      recordEvent({ kind: 'presence', code: 'absent', hostId: h.host_id,
        level: 'warn', detail: { last_seen: h.last_seen },
        ...oncePerEpisode });
    }
  }

  getSnapshot() {
    const hosts = this.getAnnotatedHosts();
    return {
      type: 'snapshot',
      timestamp: Date.now(),
      cluster: evaluateCluster(hosts),
      alerts: alertEngine.getLists(),
      thresholds,
      // S1 §5.2: the UI greys out every write action until a passphrase exists.
      // S2 §3: the same block carries the ingest-credential state, so a v1 Agent
      // running without a key is visible in the UI instead of being a footnote
      // in a server log nobody reads.
      admin: {
        passphrase_set: roster.hasPassphrase(),
        ingest_mode: ingest.mode,
        keyless_agents: roster.keylessAgents(),
        demo: demoFleet.info(),
      },
      new_nodes: roster.unconfirmed().map((n) => n.host_id),
      hosts,
    };
  }
}

export const store = new MonitorStore();
