/**
 * Four-state derivation (P1): component metrics -> node status -> cluster health.
 * Contract defined in P1-细化设计.md §1.2. Evaluation is per-frame instantaneous;
 * debouncing/alert lifecycle belongs to P2 and is NOT implemented here.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const thresholds = JSON.parse(
  readFileSync(path.join(__dirname, 'config', 'thresholds.json'), 'utf8'),
);

const RANK = { OK: 0, WARN: 1, CRIT: 2, OFFLINE: 3 };

export function worstLevel(...levels) {
  let worst = null;
  for (const l of levels) {
    if (!l) continue;
    if (worst === null || RANK[l] > RANK[worst]) worst = l;
  }
  return worst;
}

function levelFor(value, th) {
  if (value == null || Number.isNaN(value)) return null;
  if (value > th.crit) return 'CRIT';
  if (value > th.warn) return 'WARN';
  return 'OK';
}

function pushReason(reasons, metric, source, value, th, level) {
  if (!level || level === 'OK') return;
  reasons.push({ metric, source, value, threshold: level === 'CRIT' ? th.crit : th.warn, level });
}

export function evaluateHost(host) {
  const components = {
    cpu: { level: null, usage: null, temperature: null },
    mem: { level: null, percent: null },
    disk: { level: null, worst_percent: null, worst_mount: null },
    gpu: [],
    link: { level: null, targets: [] }, // filled from m.probes below (P3)
  };
  const reasons = [];

  if (!host.online) {
    const offlineSec = Math.round((Date.now() - host.lastSeen) / 1000);
    // S1 §3.2: an ephemeral node leaving the fleet is a *presence* fact, not an
    // incident. Same OFFLINE level (grey card), but no reason => nothing ever
    // enters the alert engine, banner or sound, and evaluateCluster ignores it.
    const absent = host.presence_class === 'ephemeral';
    return {
      level: 'OFFLINE',
      absent,
      components,
      reasons: absent ? [] : [{
        metric: 'offline', source: 'heartbeat', value: offlineSec,
        threshold: thresholds.offline_seconds, level: 'OFFLINE',
      }],
    };
  }

  const m = host.metrics;
  if (m) {
    // CPU: usage + temperature, worst of the two
    if (m.cpu) {
      const lu = levelFor(m.cpu.usage_percent, thresholds.cpu_usage);
      const lt = levelFor(m.cpu.temperature_c, thresholds.cpu_temp);
      components.cpu = {
        level: worstLevel(lu, lt),
        usage: m.cpu.usage_percent ?? null,
        temperature: m.cpu.temperature_c ?? null,
      };
      pushReason(reasons, 'cpu_usage', 'cpu', m.cpu.usage_percent, thresholds.cpu_usage, lu);
      pushReason(reasons, 'cpu_temp', 'cpu', m.cpu.temperature_c, thresholds.cpu_temp, lt);
    }

    // Memory (pooled percent only, per design §1.3)
    if (m.memory) {
      const l = levelFor(m.memory.percent, thresholds.mem);
      components.mem = { level: l, percent: m.memory.percent ?? null };
      pushReason(reasons, 'mem', 'mem', m.memory.percent, thresholds.mem, l);
    }

    // Disk: worst fixed partition
    if (m.disk?.partitions?.length) {
      const worst = m.disk.partitions.reduce((a, b) =>
        (b.percent > a.percent ? b : a));
      const l = levelFor(worst.percent, thresholds.disk);
      components.disk = { level: l, worst_percent: worst.percent, worst_mount: worst.mountpoint };
      pushReason(reasons, 'disk', worst.mountpoint, worst.percent, thresholds.disk, l);
    }

    // GPU: per-card temperature (thresholds per design §2.2 are temp-only)
    for (const g of m.gpu || []) {
      const l = levelFor(g.temperature_c, thresholds.gpu_temp);
      components.gpu.push({
        id: `gpu${g.index ?? 0}`, level: l,
        usage: g.usage_percent ?? null, temperature: g.temperature_c ?? null,
      });
      pushReason(reasons, 'gpu_temp', `gpu${g.index ?? 0}`, g.temperature_c, thresholds.gpu_temp, l);
    }

    // Link: star probe results (P3). Indeterminate targets are absent from
    // the frame entirely, so a restricted network never false-alarms.
    const linkTargets = [];
    for (const p of m.probes?.results || []) {
      const lr = levelFor(p.rtt_ms, thresholds.rtt_ms);
      const ll = levelFor(p.loss_pct, thresholds.packet_loss);
      const l = worstLevel(lr, ll);
      linkTargets.push({
        target: p.target, name: p.name, kind: p.kind,
        rtt_ms: p.rtt_ms ?? null, loss_pct: p.loss_pct ?? null, level: l,
      });
      pushReason(reasons, 'rtt_ms', p.target, p.rtt_ms, thresholds.rtt_ms, lr);
      pushReason(reasons, 'packet_loss', p.target, p.loss_pct, thresholds.packet_loss, ll);
    }
    components.link = {
      level: linkTargets.length
        ? (worstLevel(...linkTargets.map((t) => t.level)) || 'OK')
        : null,
      targets: linkTargets,
    };
  }

  const level = worstLevel(
    components.cpu.level, components.mem.level, components.disk.level,
    components.link.level,
    ...components.gpu.map((g) => g.level),
  ) || 'OK';

  return { level, components, reasons };
}

function avg(nums) {
  const valid = nums.filter((n) => n != null && !Number.isNaN(n));
  if (!valid.length) return null;
  return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
}

function peak(nums) {
  const valid = nums.filter((n) => n != null && !Number.isNaN(n));
  return valid.length ? Math.round(Math.max(...valid)) : null;
}

/**
 * Cluster roll-up (S1 §3.1). Health and the online ratio are computed over
 * **persistent** nodes only - that is the fix for a transient or borrowed
 * machine pinning the banner grey. Ephemeral nodes are reported as presence,
 * and aggregate load stays physical (any machine online right now really is
 * carrying load).
 */
export function evaluateCluster(hosts) {
  const classOf = (h) => h.presence_class || 'persistent';
  const persistent = hosts.filter((h) => classOf(h) === 'persistent');
  const ephemeral = hosts.filter((h) => classOf(h) === 'ephemeral');

  const online = hosts.filter((h) => h.online);
  const gpusOf = (h) => (h.metrics?.gpu || []);

  const linkLevels = online.map((h) => h.status?.components?.link?.level)
    .filter((l) => l && l !== 'OK');

  const epOnline = ephemeral.filter((h) => h.online);

  return {
    health: worstLevel(...persistent.map((h) => h.status?.level)) || 'OK',
    online: persistent.filter((h) => h.online).length,
    total: persistent.length,
    presence: { online: epOnline.length, total: ephemeral.length },
    link: {
      worst_level: worstLevel(...linkLevels) || null,
      degraded_count: linkLevels.length,
    },
    aggregate: {
      cpu: { avg: avg(online.map((h) => h.metrics?.cpu?.usage_percent)),
             peak: peak(online.map((h) => h.metrics?.cpu?.usage_percent)) },
      mem: { avg: avg(online.map((h) => h.metrics?.memory?.percent)),
             peak: peak(online.map((h) => h.metrics?.memory?.percent)) },
      gpu: { avg: avg(online.flatMap(gpusOf).map((g) => g.usage_percent)),
             peak: peak(online.flatMap(gpusOf).map((g) => g.usage_percent)) },
    },
  };
}
