/**
 * Four-state derivation (P1): component metrics -> node status -> cluster health.
 * Contract defined in P1-细化设计.md §1.2. Evaluation is per-frame instantaneous;
 * debouncing/alert lifecycle belongs to P2 and is NOT implemented here.
 *
 * S6 (H9): thresholds are no longer read from a file here - they come from the
 * live config module, and this file deliberately does **not** re-export them, so
 * "where does a threshold value come from" has exactly one answer.
 */
import { mergeNodeThresholds } from './config.js';

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
  const side = level === 'CRIT' ? 'crit' : 'warn';
  const reason = { metric, source, value, threshold: th[side], level };
  // J3: a red line this machine's owner moved must say so on the reason row.
  // Without it the next person edits the *global* threshold, sees nothing change
  // on this card, and concludes the tool is broken.
  if (th.custom?.[side]) reason.custom = true;
  reasons.push(reason);
}

export function evaluateHost(host) {
  // One merge per frame, then every read below goes through `th` - a node whose
  // owner tuned it is evaluated with its own numbers end to end, not per branch.
  const th = mergeNodeThresholds(host.thresholds_override);
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
    // S3 §4.2 extends the same mechanism to a **roster-derived absence** (a
    // persistent node that has not reported since this Server started): it belongs
    // to the denominator and to the event stream, but "it is not here" must not
    // pin the top banner grey or start the looping sound - that would trade the
    // H1 fix for H12 through the back door. A node that *was* here and dropped
    // still takes the plain OFFLINE path below, unchanged.
    const absent = host.presence_class === 'ephemeral' || host.absent_record === true;
    return {
      level: 'OFFLINE',
      absent,
      absent_record: !!host.absent_record,
      components,
      reasons: absent ? [] : [{
        metric: 'offline', source: 'heartbeat', value: offlineSec,
        threshold: th.offline_seconds, level: 'OFFLINE',
      }],
    };
  }

  const m = host.metrics;
  if (m) {
    // CPU: usage + temperature, worst of the two
    if (m.cpu) {
      const lu = levelFor(m.cpu.usage_percent, th.cpu_usage);
      const lt = levelFor(m.cpu.temperature_c, th.cpu_temp);
      components.cpu = {
        level: worstLevel(lu, lt),
        usage: m.cpu.usage_percent ?? null,
        temperature: m.cpu.temperature_c ?? null,
      };
      pushReason(reasons, 'cpu_usage', 'cpu', m.cpu.usage_percent, th.cpu_usage, lu);
      pushReason(reasons, 'cpu_temp', 'cpu', m.cpu.temperature_c, th.cpu_temp, lt);
    }

    // Memory (pooled percent only, per design §1.3)
    if (m.memory) {
      const l = levelFor(m.memory.percent, th.mem);
      components.mem = { level: l, percent: m.memory.percent ?? null };
      pushReason(reasons, 'mem', 'mem', m.memory.percent, th.mem, l);
    }

    // Disk: worst fixed partition
    if (m.disk?.partitions?.length) {
      const worst = m.disk.partitions.reduce((a, b) =>
        (b.percent > a.percent ? b : a));
      const l = levelFor(worst.percent, th.disk);
      components.disk = { level: l, worst_percent: worst.percent, worst_mount: worst.mountpoint };
      pushReason(reasons, 'disk', worst.mountpoint, worst.percent, th.disk, l);
    }

    // GPU: per-card temperature (thresholds per design §2.2 are temp-only)
    for (const g of m.gpu || []) {
      const l = levelFor(g.temperature_c, th.gpu_temp);
      components.gpu.push({
        id: `gpu${g.index ?? 0}`, level: l,
        usage: g.usage_percent ?? null, temperature: g.temperature_c ?? null,
      });
      pushReason(reasons, 'gpu_temp', `gpu${g.index ?? 0}`, g.temperature_c, th.gpu_temp, l);
    }

    // Link: star probe results (P3). Indeterminate targets are absent from
    // the frame entirely, so a restricted network never false-alarms.
    const linkTargets = [];
    for (const p of m.probes?.results || []) {
      const lr = levelFor(p.rtt_ms, th.rtt_ms);
      const ll = levelFor(p.loss_pct, th.packet_loss);
      const l = worstLevel(lr, ll);
      linkTargets.push({
        target: p.target, name: p.name, kind: p.kind,
        rtt_ms: p.rtt_ms ?? null, loss_pct: p.loss_pct ?? null, level: l,
      });
      pushReason(reasons, 'rtt_ms', p.target, p.rtt_ms, th.rtt_ms, lr);
      pushReason(reasons, 'packet_loss', p.target, p.loss_pct, th.packet_loss, ll);
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
 * **persistent, real** nodes only - that is the fix for a transient or borrowed
 * machine pinning the banner grey. Ephemeral nodes are reported as presence,
 * and aggregate load stays physical (any machine online right now really is
 * carrying load).
 *
 * S2 §5 exception to "physical": demo nodes (`kind: 'demo'`, server-generated)
 * are excluded from health, the denominator *and* the aggregate load. Average
 * CPU across the fleet is a factual claim about hardware I own; letting props
 * into it would make the number unexplainable, which is the whole S1 promise.
 * They get their own `demo` bucket so the board can still show 7 machines.
 */
export function evaluateCluster(hosts) {
  const classOf = (h) => h.presence_class || 'persistent'
  const isDemo = (h) => h.kind === 'demo'
  const real = hosts.filter((h) => !isDemo(h))
  const props = hosts.filter(isDemo)
  const persistent = real.filter((h) => classOf(h) === 'persistent')
  const ephemeral = real.filter((h) => classOf(h) === 'ephemeral')

  const realOnline = real.filter((h) => h.online);
  const gpusOf = (h) => (h.metrics?.gpu || []);

  /* A muted node contributes nothing to the top-line health/link count: the
     whole point of 🔕 is "I know about this one, stop shouting about it at the
     fleet level". Two honesty limits keep this from becoming self-deception -
     availability is never silenced (an offline muted node still reads OFFLINE),
     and every card keeps its own colour plus the expiry time. */
  const levelForHealth = (h) => {
    const s = h.status;
    if (!s) return null;
    // S3 §4.2: a roster-derived absence is not a health state. It still counts
    // in `online/total` right below - "3 台常驻，现在在 1 台" is the honest
    // answer - it just does not get to decide what colour the banner is.
    if (h.absent_record) return null;
    if (s.muted && h.online) return null;
    return s.level;
  };
  const silenced = (h) => !!h.status?.muted && !!h.online;

  const linkLevels = realOnline.filter((h) => !silenced(h))
    .map((h) => h.status?.components?.link?.level)
    .filter((l) => l && l !== 'OK');

  const epOnline = ephemeral.filter((h) => h.online);

  return {
    health: worstLevel(...persistent.map(levelForHealth)) || 'OK',
    online: persistent.filter((h) => h.online).length,
    total: persistent.length,
    muted_count: real.filter(silenced).length,
    presence: { online: epOnline.length, total: ephemeral.length },
    demo: { online: props.filter((h) => h.online).length, total: props.length },
    link: {
      worst_level: worstLevel(...linkLevels) || null,
      degraded_count: linkLevels.length,
    },
    aggregate: {
      cpu: { avg: avg(realOnline.map((h) => h.metrics?.cpu?.usage_percent)),
             peak: peak(realOnline.map((h) => h.metrics?.cpu?.usage_percent)) },
      mem: { avg: avg(realOnline.map((h) => h.metrics?.memory?.percent)),
             peak: peak(realOnline.map((h) => h.metrics?.memory?.percent)) },
      gpu: { avg: avg(realOnline.flatMap(gpusOf).map((g) => g.usage_percent)),
             peak: peak(realOnline.flatMap(gpusOf).map((g) => g.usage_percent)) },
    },
  };
}
