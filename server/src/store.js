/**
 * In-memory data store for host monitoring.
 * Tracks connected hosts, their topology, latest metrics, and online status.
 */

const OFFLINE_TIMEOUT_MS = 15_000;

class MonitorStore {
  constructor() {
    /** @type {Map<string, HostRecord>} */
    this.hosts = new Map();
  }

  /**
   * Register or update a host (now includes topology).
   */
  register(hostId, info = {}) {
    const existing = this.hosts.get(hostId);
    if (existing) {
      existing.hostname = info.hostname || existing.hostname;
      existing.platform = info.platform || existing.platform;
      if (info.topology) existing.topology = info.topology;
      existing.lastSeen = Date.now();
      existing.online = true;
    } else {
      this.hosts.set(hostId, {
        host_id: hostId,
        hostname: info.hostname || hostId,
        platform: info.platform || 'unknown',
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

  getSnapshot() {
    this.checkTimeouts();
    return {
      type: 'snapshot',
      timestamp: Date.now(),
      hosts: this.getAllHosts(),
    };
  }
}

export const store = new MonitorStore();
