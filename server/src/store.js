/**
 * In-memory data store for host monitoring.
 * Tracks connected hosts, their topology, latest metrics, and online status.
 */
import { evaluateHost, evaluateCluster, thresholds } from './status.js';
import { alertEngine } from './alerts.js';
import { roster } from './roster.js';
import { ingest } from './ingest.js';
import { demoFleet } from './demo.js';

const OFFLINE_TIMEOUT_MS = 15_000;

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

  checkTimeouts() {
    const now = Date.now();
    for (const [, host] of this.hosts) {
      if (host.online && (now - host.lastSeen) > OFFLINE_TIMEOUT_MS) {
        host.online = false;
      }
    }
  }

  getAllHosts() {
    return Array.from(this.hosts.values());
  }

  /**
   * Annotated hosts: roster facts attached, instant four-state, then debounced
   * by the alert engine. Retired nodes are filtered out here so they leave the
   * dashboard, every aggregate and the alert path in one stroke - their rows
   * stay in the store (and their history stays queryable by host_id).
   */
  getAnnotatedHosts() {
    this.checkTimeouts();
    const hosts = this.getAllHosts()
      .filter((h) => roster.classOf(h.host_id) !== 'retired');
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
    alertEngine.tick(hosts);
    return hosts;
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
