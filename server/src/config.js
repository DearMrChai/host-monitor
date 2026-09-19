/**
 * Runtime configuration (S6 §2, closes H9): one source of truth while the
 * process is alive, and writable without a restart.
 *
 * Why this exists at all: a settings screen over config that only JSON files
 * can change is worse than no settings screen - it is a form that looks
 * editable and isn't. So the DB is the runtime truth, and the files are a
 * first-boot seed only.
 *
 * Two rules hold this together, and both are load-bearing:
 *  1. **In-place mutation, never reassignment.** `thresholds` and `probes` are
 *     exported objects that every reader already holds a reference to; a reload
 *     writes *into* them (`replaceInto`). Reassigning would silently freeze
 *     every `import { thresholds }` at its boot value - and selftest-config B
 *     goes red the moment someone does, because that is the only way a
 *     convention like this can be enforced.
 *  2. **This module imports nothing from the project.** status.js reads config,
 *     roster.js owns the DB, events.js is imported by roster.js - so a
 *     `config -> roster` import would close a cycle (status -> config -> roster
 *     -> events -> status) that ESM resolves but nobody can reason about at
 *     init time. Persistence arrives through `attach()`, wired in index.js,
 *     exactly like events.attach(history).
 *
 * Validation lives here, on the write side, and rejects rather than "corrects":
 * a silently nudged threshold is a value nobody recognizes later.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The live global thresholds. Mutated in place by load()/setThresholds(). */
export const thresholds = {};
/** The live global probe plan (null when neither the DB nor probes.json has one). */
export const probes = {};

const KEY_TH = 'thresholds';
const KEY_PROBES = 'probes';

/* ---------- validation spec ---------- */

const METRICS = {
  cpu_usage: { min: 1, max: 100 },
  cpu_temp: { min: 20, max: 120 },
  mem: { min: 1, max: 100 },
  disk: { min: 1, max: 100 },
  gpu_temp: { min: 20, max: 120 },
  rtt_ms: { min: 1, max: 5000 },
  packet_loss: { min: 0.1, max: 100 },
};

const SCALARS = {
  offline_seconds: { min: 5, max: 600 },
  'alert.debounce_cycles': { min: 1, max: 10, int: true },
  'alert.resolved_keep_minutes': { min: 1, max: 240 },
  'alert.history_capacity': { min: 20, max: 5000, int: true },
  'alert.tick_ms': { min: 500, max: 10_000, int: true },
  'alert.unknown_alert_grace_minutes': { min: 1, max: 240 },
  'events.merge_seconds': { min: 5, max: 3600, int: true },
  'presence.absent_after_minutes': { min: 1, max: 240 },
  'presence.degrade_after_minutes': { min: 2, max: 1440 },
};

/** Timing keys the Agent reads straight off the probe plan. They stay in the
 *  plan object (rather than moving under a new name) because `prober.py` already
 *  reads them by these names and the Agent is not being redeployed this batch. */
const TIMING_KEYS = ['probe_interval_seconds', 'window_size'];
const TIMING = {
  probe_interval_seconds: { min: 1, max: 600 },
  window_size: { min: 3, max: 120 },
};

/** Must match `nodes.site TEXT NOT NULL DEFAULT 'home'` in roster.js: a plan
 *  with no explicit `site` label is the Server's own site, which today is the
 *  only site in the fleet. */
const DEFAULT_SITE = 'home';

function deepGet(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function deepSet(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  let node = obj;
  for (const k of keys) node = node[k] ??= {};
  node[last] = value;
}

function numberAt(pathKey, spec, src, errors, label = pathKey) {
  const v = deepGet(src, pathKey);
  if (v === undefined) return;
  const n = Number(v);
  if (!Number.isFinite(n)) { errors.push(`${label} 不是数字`); return; }
  if (spec.int && !Number.isInteger(n)) { errors.push(`${label} 需要整数`); return; }
  if (n < spec.min || n > spec.max) { errors.push(`${label} 需在 ${spec.min}~${spec.max} 之间`); return; }
  deepSet(src, pathKey, n);
}

/**
 * Validate a full candidate threshold object. Mutates `next` to normalized
 * numbers (so "80" from an <input> becomes 80) and returns the list of reasons
 * it should be refused - empty list means accepted.
 */
export function validateThresholds(next) {
  const errors = [];
  for (const [key, range] of Object.entries(METRICS)) {
    const pair = next[key];
    if (pair === undefined) continue;
    if (typeof pair !== 'object' || pair === null) { errors.push(`${key} 需要 {{warn, crit}}`); continue; }
    // `src` here is the pair itself, so the path is one segment and the full
    // name only travels as the label. Passing `${key}.${side}` instead made
    // deepGet look for `pair.cpu_usage.warn`, find nothing, and skip - which
    // silently left every metric pair neither range-checked nor coerced
    // (selftest B6 is the assertion that catches it).
    for (const side of ['warn', 'crit']) {
      numberAt(side, range, pair, errors, `${key}.${side}`);
    }
    const w = pair.warn; const c = pair.crit;
    if (Number.isFinite(w) && Number.isFinite(c) && c < w) {
      errors.push(`${key}：严重档不能低于警告档`);
    }
  }
  for (const [key, spec] of Object.entries(SCALARS)) numberAt(key, spec, next, errors);
  if (next.presence && typeof next.presence.enabled !== 'boolean' && next.presence.enabled !== undefined) {
    errors.push('presence.enabled 需要 true/false');
  }
  const a = deepGet(next, 'presence.absent_after_minutes');
  const d = deepGet(next, 'presence.degrade_after_minutes');
  if (Number.isFinite(a) && Number.isFinite(d) && d < a) {
    // They answer different questions (H18), but a shorter silence window than
    // the restart window would make "absent" unreachable - a config that cannot
    // mean anything is refused, not quietly accepted.
    errors.push('degrade_after_minutes 不应小于 absent_after_minutes（静默降级比跨重启缺席还早 = 前者永远轮不到）');
  }
  for (const k of Object.keys(next)) {
    if (!METRICS[k] && !SCALARS[k] && !['presence', 'alert', 'events'].includes(k)) {
      errors.push(`未知配置项 ${k}`);
    }
  }
  return errors;
}

/* ---------- storage plumbing ---------- */

let store = null;   // { get(key), set(key, value) } - injected by attach()
let seededFromFile = true;

function replaceInto(target, next) {
  for (const k of Object.keys(target)) if (!(k in next)) delete target[k];
  Object.assign(target, next);
}

function readSeed(file) {
  try {
    return JSON.parse(readFileSync(path.join(__dirname, 'config', file), 'utf8'));
  } catch {
    return null;
  }
}

function loadFromStore() {
  const raw = store?.get(KEY_TH);
  const seed = readSeed('thresholds.json');
  if (raw == null) {
    seededFromFile = true;
    if (!seed) return;
    replaceInto(thresholds, seed);
    store.set(KEY_TH, JSON.stringify(seed));   // first boot: the file becomes the DB
    return;
  }
  // H9's whole point: once the DB has a row, thresholds.json is not read again.
  seededFromFile = false;
  try {
    replaceInto(thresholds, JSON.parse(raw));
  } catch {
    if (seed) replaceInto(thresholds, seed);
  }
}

const listeners = new Set();
function notify(what) {
  for (const fn of [...listeners]) {
    try { fn(what); } catch { /* a listener must not break a config write */ }
  }
}

/**
 * Wire persistence and load. `seedFiles` are read only when the DB has no row
 * for that key, so calling this twice (a selftest that rebuilds the Server) is
 * safe as long as the same store is used.
 */
export function attach(nextStore) {
  store = nextStore;
  loadFromStore();
  const rawProbes = store.get(KEY_PROBES);
  if (rawProbes == null) {
    if (Object.keys(probes).length) store.set(KEY_PROBES, JSON.stringify(probes));
  } else {
    try { replaceInto(probes, JSON.parse(rawProbes)); } catch { /* keep last good */ }
  }
  return snapshot();
}

// Populate from the seed files at import, before anyone can call attach().
// Two reasons: a selftest that imports status.js without a Server gets the
// shipped values instead of an empty object (silently "no thresholds" is the
// worst possible failure mode for an alerting system), and `attach` then only
// has to overwrite what the DB actually says. The file stops being a runtime
// truth the moment attach() finds a row - that is J2, asserted by selftest A.
function loadSeeds() {
  const th = readSeed('thresholds.json');
  if (th) replaceInto(thresholds, th);
  const pr = readSeed('probes.json');
  if (pr) replaceInto(probes, pr);
}
loadSeeds();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ---------- writes ---------- */

/** Full replacement of the global thresholds (the settings UI sends the whole table). */
export function setThresholds(next) {
  const candidate = JSON.parse(JSON.stringify(next || {}));
  const errors = validateThresholds(candidate);
  if (errors.length) return { ok: false, errors };
  replaceInto(thresholds, candidate);
  store.set(KEY_TH, JSON.stringify(thresholds));
  seededFromFile = false;
  notify('thresholds');
  return { ok: true, thresholds };
}

/** Back to whatever config/thresholds.json says (the escape hatch when the UI
 *  has been used to paint yourself into a corner). */
export function resetThresholdsToSeed() {
  const seed = readSeed('thresholds.json');
  if (!seed) return { ok: false, errors: ['找不到 thresholds.json，无法回落'] };
  return setThresholds(seed);
}

/** Partial edit of one node's overrides is roster's job (it owns the node row);
 *  config only validates the shape it holds. A node may override one side only
 *  (`{cpu_usage:{crit:95}}` = "let my compile boxes go red later, keep the
 *  yellow where the fleet keeps it"), so each side is checked independently. */
export function validateNodeOverrides(patch) {
  const clean = {};
  const errors = [];
  for (const [key, pair] of Object.entries(patch || {})) {
    if (!METRICS[key]) { errors.push(`未知配置项 ${key}`); continue; }
    if (typeof pair !== 'object' || pair === null) { errors.push(`${key} 需要 {warn, crit}`); continue; }
    // numberAt coerces and validates in place inside `pair`, pushing reasons.
    for (const side of ['warn', 'crit']) {
      numberAt(side, METRICS[key], pair, errors, `${key}.${side}`);
    }
    const out = {};
    if (Number.isFinite(pair.warn)) out.warn = pair.warn;
    if (Number.isFinite(pair.crit)) out.crit = pair.crit;
    if (Number.isFinite(out.warn) && Number.isFinite(out.crit) && out.crit < out.warn) {
      errors.push(`${key}：严重档不能低于警告档`);
    }
    if (Object.keys(out).length) clean[key] = out;
  }
  return errors.length ? { ok: false, errors } : { ok: true, overrides: clean };
}

export function setProbes(next) {
  const err = validateProbes(next);
  if (err.length) return { ok: false, errors: err };
  replaceInto(probes, JSON.parse(JSON.stringify(next)));
  store.set(KEY_PROBES, JSON.stringify(probes));
  notify('probes');
  return { ok: true, probes };
}

/** Probe targets are host:port the Server hands to Agents; validate shape, and
 *  refuse a plan that would make the Server probe itself into a loop. */
export function validateProbes(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return ['探测计划需要一个对象'];
  for (const key of TIMING_KEYS) {
    const spec = TIMING[key];
    if (plan[key] === undefined) continue;
    const n = Number(plan[key]);
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
      errors.push(`${key} 需为 ${spec.min}~${spec.max} 的整数`);
    }
  }
  if (plan.site !== undefined && typeof plan.site !== 'string') errors.push('site 需要字符串');
  if (plan.gateway !== undefined) errors.push(...probeTargetErrors(plan.gateway, 'gateway'));
  if (plan.key_hosts !== undefined) {
    if (!Array.isArray(plan.key_hosts)) errors.push('key_hosts 需要数组');
    else if (plan.key_hosts.length > 8) errors.push('key_hosts 最多 8 个（探测环预算有限，H3）');
    else plan.key_hosts.forEach((h, i) => errors.push(...probeTargetErrors(h, `key_hosts[${i}]`)));
  }
  if (plan.sites !== undefined) {
    if (typeof plan.sites !== 'object' || Array.isArray(plan.sites)) errors.push('sites 需要 {站点名: 计划} 的映射');
    else for (const [site, p] of Object.entries(plan.sites)) {
      // The site name is also a node column value (nodes.site) and a lookup key,
      // so it has to be a shaped token for both sides to be able to find it.
      if (!/^[a-z0-9_-]{1,20}$/.test(site)) { errors.push(`站点名 ${site} 需为小写字母/数字/-/_（≤20 字）`); continue; }
      if (!p || typeof p !== 'object') { errors.push(`sites.${site} 需要一个计划对象`); continue; }
      errors.push(...probeTargetErrors(p.gateway, `sites.${site}.gateway`));
      if (p.key_hosts !== undefined) {
        if (!Array.isArray(p.key_hosts)) errors.push(`sites.${site}.key_hosts 需要数组`);
        else p.key_hosts.forEach((h, i) => errors.push(...probeTargetErrors(h, `sites.${site}.key_hosts[${i}]`)));
      }
    }
  }
  return errors;
}

function probeTargetErrors(t, label) {
  if (!t || typeof t !== 'object') return [`${label} 需要一个对象`];
  if (typeof t.host !== 'string' || !t.host.trim()) return [`${label}.host 不能为空`];
  if (t.host.length > 64) return [`${label}.host 过长`];
  if (t.tcp_port !== undefined) {
    const p = Number(t.tcp_port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return [`${label}.tcp_port 需在 1~65535`];
  }
  return [];
}

/* ---------- reads used by the rest of the server ---------- */

/**
 * The thresholds a given node should be evaluated against: global, with this
 * node's overrides winning per side. `override` is `nodes.settings_json.thresholds`.
 * A fresh object each call - callers must not hold it across frames.
 */
export function mergeNodeThresholds(override) {
  if (!override || typeof override !== 'object') return thresholds;
  const out = { ...thresholds };
  for (const [key, pair] of Object.entries(override)) {
    if (!METRICS[key] || !pair) continue;
    const base = thresholds[key] || {};
    const merged = { ...base };
    if (Number.isFinite(Number(pair.warn))) merged.warn = Number(pair.warn);
    if (Number.isFinite(Number(pair.crit))) merged.crit = Number(pair.crit);
    out[key] = merged;
    // Which side came from the node is what the UI prints next to the number
    // ("该机自定义"), so a passers-by can tell a friend's tuned box from the fleet default.
    out[key].custom = {
      warn: Number.isFinite(Number(pair.warn)),
      crit: Number.isFinite(Number(pair.crit)),
    };
  }
  return out;
}

/**
 * Which probe plan an Agent should run (H6): its own, else its site's, else the
 * Server's global one. A plan is selected **whole**, not merged field by field:
 * "office inherits the home gateway unless it says otherwise" is exactly the
 * mistake this section exists to stop, so a site that defines only `key_hosts`
 * probes no gateway rather than somebody else's.
 *
 * `source` travels to the Agent and the board, because "this box is probing a
 * gateway it may not be able to see" is a fact the operator has to be able to
 * see - not a detail we hide in a config file.
 */
export function probePlanFor({ site, override } = {}) {
  if (override && typeof override === 'object') {
    return { plan: assemblePlan(override), source: 'node', suspect: false };
  }
  // Own-property lookup only: `sites['__proto__']` would otherwise find a plan
  // that nobody wrote and hand the node an empty target list.
  const s = site && Object.prototype.hasOwnProperty.call(probes.sites || {}, site)
    ? probes.sites[site] : null;
  if (s && typeof s === 'object') {
    return { plan: assemblePlan(s), source: 'site', suspect: false };
  }
  if (probes.gateway || probes.key_hosts) {
    return {
      plan: assemblePlan(probes),
      source: 'global',
      // The one case where inheriting is probably wrong: a node that says it
      // lives at another site is about to probe *this* site's gateway, and
      // there is no sites[<that site>] entry to stop it.
      suspect: !!site && site !== (probes.site || DEFAULT_SITE),
    };
  }
  return { plan: null, source: 'none', suspect: false };
}

/** Turn one selected plan into the frame field the Agent reads. Timing keys fall
 *  back to the global values so a node override can change *what* is probed
 *  without re-specifying *how often*; `undefined` is dropped because
 *  `prober.apply_plan` treats a present-but-null interval as a value, not as
 *  "keep the default". */
function assemblePlan(src) {
  const plan = {};
  for (const key of TIMING_KEYS) {
    const v = src?.[key] ?? probes[key];
    if (v !== undefined && v !== null) plan[key] = v;
  }
  plan.gateway = src?.gateway ?? null;
  plan.key_hosts = Array.isArray(src?.key_hosts) ? src.key_hosts : [];
  return plan;
}

/** What the settings UI renders: current truth + the ranges it may use. */
export function snapshot() {
  return {
    thresholds: JSON.parse(JSON.stringify(thresholds)),
    probes: Object.keys(probes).length ? JSON.parse(JSON.stringify(probes)) : null,
    spec: {
      metrics: Object.entries(METRICS).map(([key, r]) => ({ key, min: r.min, max: r.max })),
      scalars: Object.entries(SCALARS).map(([key, r]) => ({ key, min: r.min, max: r.max, int: !!r.int })),
    },
    // "Still the shipped defaults" is a fact the UI should say out loud: it is
    // the difference between "nobody tuned this" and "someone tuned this to 0".
    untouched_since_seed: seededFromFile,
  };
}

/**
 * The read-side view (S5 G3): probe targets are real addresses on a board that
 * has no read gate, so names travel in full and hosts are masked. The operator
 * still sees the value when they open the editor, because the editor's *write*
 * is what carries it - and a wrong target is caught by the link arm going grey,
 * not by reading it back.
 */
export function publicSnapshot() {
  const s = snapshot();
  if (s.probes) s.probes = maskPlan(s.probes);
  return s;
}

/** For any other endpoint that has to show a plan without giving out targets. */
export function maskProbePlan(plan) { return maskPlan(plan || {}) }

function maskPlan(plan) {
  const out = { ...plan };
  if (out.gateway) out.gateway = maskTarget(out.gateway);
  if (Array.isArray(out.key_hosts)) out.key_hosts = out.key_hosts.map(maskTarget);
  if (out.sites && typeof out.sites === 'object') {
    out.sites = Object.fromEntries(Object.entries(out.sites).map(([k, p]) => [k, {
      ...p,
      gateway: p?.gateway ? maskTarget(p.gateway) : p?.gateway,
      key_hosts: Array.isArray(p?.key_hosts) ? p.key_hosts.map(maskTarget) : p?.key_hosts,
    }]));
  }
  return out;
}

function maskTarget(t) {
  // Same shape as the ingest log's address mask: the first two octets survive,
  // enough to tell 192.168.x from 10.226.x apart, not enough to hit the host.
  const host = String(t.host ?? '');
  const parts = host.split('.');
  return {
    ...t,
    host: parts.length === 4 ? `${parts[0]}.${parts[1]}.*.*` : (host ? '*'.repeat(host.length) : ''),
    host_masked: true,
  };
}
