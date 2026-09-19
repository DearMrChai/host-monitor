/**
 * Host Monitor Server
 * ===================
 * Central relay: receives metrics + topology from Python agents,
 * stores in memory, broadcasts to Vue frontend clients.
 *
 * Ports:
 *   - 9100: WebSocket for Agent connections
 *   - 9101: HTTP REST API + WebSocket for Client connections
 */
import express from 'express';
import cors from 'cors';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { store, nodeProbePlan } from './store.js';
import { evaluateCluster } from './status.js';
import { history } from './history.js';
import { alertEngine } from './alerts.js';
import { roster, CLASSES } from './roster.js';
import { ingest, REASON_TEXT } from './ingest.js';
import { demoFleet } from './demo.js';
import { ztPresence } from './zerotier.js';
import * as config from './config.js';
import * as events from './events.js';

// Overridable so the self-test can run a throwaway Server beside a live one.
const AGENT_PORT = Number(process.env.HM_AGENT_PORT) || 9100;
const CLIENT_PORT = Number(process.env.HM_CLIENT_PORT) || 9101;
const BROADCAST_INTERVAL_MS = 2000;

// S6 §2 (H9): the DB is the runtime truth; config/thresholds.json and
// config/probes.json are read only to seed an empty settings table. This call
// must come before anything evaluates a frame.
config.attach({
  get: (key) => roster.getSetting(key),
  set: (key, value) => roster.setSetting(key, value),
});

// P5: replay persisted active alerts so a restart doesn't lose them (design §7).
alertEngine.restoreActive(history.activeAlertRows());

// S3 §2/§5: the durable event stream lives in the history DB, and it renders
// names through the roster - both are wired here rather than imported by
// events.js, so a self-test that builds a Roster cannot drag the production
// history file along with it. Nothing records until this call succeeds.
events.attach(history, {
  nameOf: (id) => roster.get(id)?.display_name || id,
  reasonText: (reason) => REASON_TEXT[reason] || reason,
});

// S2 §5: the demo fleet writes straight into the store; it is off unless it was
// switched on before (roster meta) or explicitly pre-armed with HM_DEMO=1.
demoFleet.attach(store);
demoFleet.autoStart();

// S5 §4: the presence poll is its own clock; it never touches the store.
ztPresence.start();

// ============================================================
// Agent WebSocket Server (port 9100)
// ============================================================
const agentWss = new WebSocketServer({ port: AGENT_PORT });
console.log(`[Server] Agent WebSocket listening on ws://0.0.0.0:${AGENT_PORT}`);

agentWss.on('connection', (ws, req) => {
  const agentAddr = req.socket.remoteAddress;
  let hostId = null;
  console.log(`[Server] Agent connected from ${agentAddr}`);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'register') {
        const v = ingest.authorize({
          hostId: msg.host_id,
          token: msg.token,
          addr: agentAddr,
          fingerprint: msg.fingerprint,
        });
        if (!v.ok) {
          // Say why, then hang up: a silent close reads as a network fault and
          // the person holding the wrong code never learns to go get a new one.
          ws.send(JSON.stringify({ type: 'rejected', reason: v.reason }));
          ws.close(4001, v.reason);
          return;
        }
        hostId = msg.host_id;
        store.register(hostId, {
          hostname: msg.hostname,
          platform: msg.platform,
          role: msg.role,
          topology: msg.topology,  // Pass topology through
          agent_version: msg.agent_version,
          fingerprint: msg.fingerprint,
          // `kind` is deliberately NOT taken from the frame: demo/observed are
          // server-side classifications, and a node that could call itself
          // "demo" could opt out of the cluster denominator and the health
          // roll-up (S2 §5 in reverse). The in-process demo generator is the
          // only caller that passes a kind.
          // S2 §2: pairing mints the node's standing key, which the Agent then
          // keeps in its identity file. Deliberately not echoed to any read endpoint.
          node_key: v.node_key || null,
          confirmed: !!v.paired,
        });
        console.log(`[Server] Agent registered: ${hostId} (${msg.hostname}) role=${msg.role || 'other'}` +
          `${v.paired ? ' [paired]' : v.legacy ? ' [no credential - legacy grace]' : ''}`);
        if (msg.topology) {
          const t = msg.topology;
          console.log(`[Server]   Topology: ${t.cpu?.model}, ` +
            `${t.memory?.sticks?.length || 0} DIMM, ` +
            `${t.gpu?.length || 0} GPU`);
        }
        // S6 §4 (H6): the plan is derived per node, and the *source* travels with
        // it. The Agent does not interpret the source - it prints it, so the line
        // in its log says which gateway it was told to ping and why.
        const pp = nodeProbePlan(hostId);
        ws.send(JSON.stringify({
          type: 'registered', host_id: hostId, probe_plan: pp.plan,
          probe_plan_source: pp.source,
          node_key: v.node_key || undefined,
        }));
      } else if (msg.type === 'metrics') {
        // S2 §4: one connection writes one node. Anything else is refused per
        // frame and lands in the ingest event log.
        if (!ingest.frameHostMatches(hostId, msg.host_id, agentAddr)) return;
        hostId = hostId || msg.host_id;
        if (hostId) store.updateMetrics(hostId, msg);
      }
    } catch (err) {
      console.error('[Server] Bad message from agent:', err.message);
    }
  });

  ws.on('close', () => {
    if (hostId) {
      store.markDisconnected(hostId);
      console.log(`[Server] Agent disconnected: ${hostId}`);
    }
  });

  ws.on('error', (err) => {
    console.error('[Server] Agent WS error:', err.message);
  });
});

// ============================================================
// Client HTTP + WebSocket Server (port 9101)
// ============================================================
const app = express();
// Exported for the S5 credential-hygiene self-test, which reads the real route
// table (S5 §3.1): "every mutating endpoint is behind the passphrase" has to be
// something a test can enumerate, not something a reviewer hopes is true.
export { app };
app.use(cors());
app.use(express.json());

app.get('/api/hosts', (req, res) => {
  const hosts = store.getAnnotatedHosts();
  // admin travels here too so the very first paint already knows whether writes
  // are possible; without it every card menu flashes locked for one WS frame.
  res.json({ hosts, cluster: evaluateCluster(hosts), admin: { passphrase_set: roster.hasPassphrase() } });
});

app.get('/api/alerts', (req, res) => {
  res.json(store.getSnapshot().alerts);
});

// P5: persisted history. GET /api/history/<host_id>?range=2h|24h|7d|30d
app.get('/api/history/:hostId', (req, res) => {
  const valid = ['2h', '24h', '7d', '30d'];
  const range = valid.includes(req.query.range) ? req.query.range : '2h';
  res.json(history.getSeries(req.params.hostId, range));
});

// P5: full alert lifecycle log (memory list keeps only the 5-min fold window)
app.get('/api/alerts/history', (req, res) => {
  res.json({ alerts: history.alertHistory(Number(req.query.limit) || 200) });
});

// S3 §5: "what changed in this fleet in the last 24 hours" - the durable answer
// behind H12/H15/H17. Read side stays unauthenticated (revised decision 6: read
// open, write behind the passphrase). Contract: no token, no passphrase, no
// fingerprint value and no full peer address leaves this endpoint.
app.get('/api/events', (req, res) => {
  res.json(events.read({
    window: req.query.window,
    hostId: req.query.host || null,
    limit: Number(req.query.limit) || undefined,
  }));
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ============================================================
// S1: roster (read open, write behind an admin passphrase - design §5)
// ============================================================
app.get('/api/roster', (req, res) => {
  const nodes = [...roster.cache.values()].map((n) => roster.publicOf(n.host_id));
  res.json({
    nodes,
    retired: roster.retired().map((n) => roster.publicOf(n.host_id)),
    admin: { passphrase_set: roster.hasPassphrase() },
  });
});

// Default-deny: with no passphrase configured every write is refused, so a
// pass-by visitor can neither retire a node nor change its class (S1 §5.2).
//
// The budget below is not a login-throttle, it is the cost of the hash:
// `checkPassphrase` runs scrypt, and this box is a low-power machine whose port
// 9101 is open to the LAN. Without a cap, anyone with curl can spend our CPU on
// every request (and guess for free). The check therefore happens BEFORE the
// hash, and a blocked address gets an answer that costs us nothing.
// Addresses are memory-only keys: never logged, never in an event row (S5 G3).
const ADMIN_FAIL_WINDOW_MS = 60_000
const ADMIN_FAIL_MAX = 8
const ADMIN_BUDGET_MAX_KEYS = 512
const adminFails = new Map();

function failState(addr, now) {
  const s = adminFails.get(addr)
  if (!s || now > s.until) return null
  return s
}

function adminBlocked(addr, now = Date.now()) {
  const s = failState(addr, now)
  return !!s && s.n >= ADMIN_FAIL_MAX
}

function noteAdminFail(addr, now = Date.now()) {
  if (adminFails.size >= ADMIN_BUDGET_MAX_KEYS) {
    for (const [k, v] of adminFails) if (v.until <= now) adminFails.delete(k)
    // A box with more live addresses than the cap is not this deployment; drop
    // the ledger rather than let it grow, because losing a throttle is a smaller
    // failure than losing the process to OOM.
    if (adminFails.size >= ADMIN_BUDGET_MAX_KEYS) adminFails.clear()
  }
  const s = failState(addr, now)
  if (s) s.n += 1
  else adminFails.set(addr, { n: 1, until: now + ADMIN_FAIL_WINDOW_MS })
}

/** Self-test hook. */
export const _adminFails = adminFails;

function requireAdmin(req, res, next) {
  const addr = req.socket.remoteAddress || '?';
  if (adminBlocked(addr)) {
    return res.status(429).json({ error: '口令尝试过于频繁，请稍后再试' });
  }
  if (!roster.hasPassphrase()) {
    return res.status(403).json({ error: '未设置管理口令，写操作已禁用' });
  }
  if (!roster.checkPassphrase(req.get('x-hm-admin'))) {
    noteAdminFail(addr);
    return res.status(403).json({ error: '口令不正确' });
  }
  adminFails.delete(addr);
  return next();
}

// The one endpoint that cannot sit behind its own gate: on a fresh install there
// is no passphrase to present yet. It is still guarded - `setPassphrase` demands
// the old one as soon as one exists - and it pays for the same scrypt, so it
// shares the budget (S5 §3.1: this is the whitelist entry, with its reason).
app.post('/api/admin/passphrase', (req, res) => {
  const addr = req.socket.remoteAddress || '?';
  if (adminBlocked(addr)) {
    return res.status(429).json({ error: '口令尝试过于频繁，请稍后再试' });
  }
  const { passphrase, old } = req.body || {};
  const r = roster.setPassphrase(passphrase, old);
  if (!r.ok) {
    if (r.error === '原口令不正确') noteAdminFail(addr);
    return res.status(400).json({ error: r.error });
  }
  adminFails.delete(addr);
  console.log('[Roster] Admin passphrase set');
  res.json({ ok: true });
});

app.post('/api/roster/:hostId/class', requireAdmin, (req, res) => {
  const { cls } = req.body || {};
  if (!CLASSES.includes(cls)) {
    return res.status(400).json({ error: `cls 必须是 ${CLASSES.join(' / ')}` });
  }
  const r = roster.setClass(req.params.hostId, cls);
  if (!r.ok) return res.status(404).json({ error: r.error });
  console.log(`[Roster] ${req.params.hostId} -> ${cls}`);
  res.json({ ok: true, node: roster.publicOf(req.params.hostId) });
});

app.post('/api/roster/:hostId/mute', requireAdmin, (req, res) => {
  const { hours, cancel } = req.body || {};
  const until = cancel ? null
    : hours === 'today' ? 'today'
    : Number.isFinite(Number(hours)) && Number(hours) > 0
      ? Date.now() + Number(hours) * 3_600_000
      : null;
  if (until === null && !cancel) return res.status(400).json({ error: 'hours 无效' });
  const r = roster.setMute(req.params.hostId, until);
  if (!r.ok) return res.status(404).json({ error: r.error });
  console.log(`[Roster] ${req.params.hostId} mute -> ${until === null ? 'off' : JSON.stringify(until)}`);
  res.json({ ok: true, node: roster.publicOf(req.params.hostId) });
});

app.post('/api/roster/:hostId/name', requireAdmin, (req, res) => {
  const r = roster.setDisplay(req.params.hostId, (req.body || {}).name);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, node: roster.publicOf(req.params.hostId) });
});

// ============================================================
// S6: settings (design §5). The board's reads are open by decision, so
// everything on the read side is the *masked* view (S5 G3), and every write here
// takes the single `requireAdmin` gate - the hygiene self-test enumerates the
// routes, so a new endpoint without a gate is red, not forgotten (J6).
// ============================================================

function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));
}

/** One line in the event stream per config write. Values are not recorded: the
 *  stream is readable without a passphrase, and the current value is already at
 *  /api/config - the audit question is "when did somebody touch this", not "what
 *  did they type". */
function noteConfigWrite(code, hostId, detail) {
  events.record({ kind: 'roster', code, hostId: hostId || null, level: 'info', detail });
}

app.get('/api/config', (req, res) => {
  const s = config.publicSnapshot();
  s.nodes = roster.active().map((n) => ({
    host_id: n.host_id,
    display_name: n.display_name,
    owner: n.owner,
    site: n.site,
    role: n.role,
    presence_class: n.presence_class,
    thresholds: roster.nodeThresholds(n.host_id),
    probes: roster.nodeProbes(n.host_id) ? config.maskProbePlan(roster.nodeProbes(n.host_id)) : null,
    muted_until: roster.mutedUntil(n.host_id),
  }));
  res.json(s);
});

/**
 * The same document, unmasked, behind the gate — and the only read in this
 * process that is. `GET /api/config` cannot carry real probe targets (they are
 * LAN addresses on an open board), but an editor that only ever sees
 * `192.168.*.*` would make every save a re-typing exercise, and a half-remembered
 * gateway is a silent way to break the link arm. So the edit form reads this one.
 * The hygiene suite whitelists the path *by name* with this reason attached.
 */
app.get('/api/admin/config', requireAdmin, (req, res) => {
  const s = config.snapshot();
  s.nodes = roster.active().map((n) => ({
    host_id: n.host_id,
    display_name: n.display_name,
    owner: n.owner,
    site: n.site,
    role: n.role,
    presence_class: n.presence_class,
    thresholds: roster.nodeThresholds(n.host_id),
    probes: roster.nodeProbes(n.host_id),
    muted_until: roster.mutedUntil(n.host_id),
  }));
  res.json(s);
});

app.post('/api/admin/config/thresholds', requireAdmin, (req, res) => {
  const body = req.body || {};
  const before = { ...config.thresholds };
  const r = body.reset === true
    ? config.resetThresholdsToSeed()
    : config.setThresholds(body.thresholds ?? body);
  if (!r.ok) return res.status(400).json({ error: '阈值不符合约束', errors: r.errors });
  const keys = changedKeys(before, config.thresholds);
  if (keys.length) noteConfigWrite('thresholds_global', null, { keys, reset: !!body.reset });
  res.json({ ok: true, changed: keys, config: config.publicSnapshot() });
});

app.post('/api/admin/config/probes', requireAdmin, (req, res) => {
  const body = req.body || {};
  const r = config.setProbes(body.probes ?? body);
  if (!r.ok) return res.status(400).json({ error: '探测计划不符合约束', errors: r.errors });
  noteConfigWrite('probes_global', null, {});
  // Honest timing (design §4): an Agent picks up a new plan when it registers,
  // so the change is live on next reconnect - not "instantly".
  res.json({ ok: true, applies_on: 'agent_reconnect', config: config.publicSnapshot() });
});

app.post('/api/roster/:hostId/settings', requireAdmin, (req, res) => {
  const { hostId } = req.params;
  const r = roster.setProfile(hostId, req.body || {});
  if (!r.ok) return res.status(r.error === 'no such node' ? 404 : 400).json({ error: r.error });
  res.json({ ok: true, changed: r.changed, node: roster.publicOf(hostId) });
});

app.post('/api/roster/:hostId/thresholds', requireAdmin, (req, res) => {
  const { hostId } = req.params;
  const patch = (req.body || {}).thresholds;
  if (!roster.get(hostId)) return res.status(404).json({ error: 'no such node' });
  if (patch === null) {
    const r = roster.setNodeSettings(hostId, { thresholds: null },
      { code: 'node_thresholds', detail: { cleared: true } });
    if (!r.ok) return res.status(404).json({ error: r.error });
    return res.json({ ok: true, cleared: true, config: config.publicSnapshot() });
  }
  const v = config.validateNodeOverrides(patch);
  if (!v.ok) return res.status(400).json({ error: '该机阈值不符合约束', errors: v.errors });
  // An empty override map means "inherit everything", which is the same state as
  // no key at all - storing {} would leave a node that looks customized forever.
  const keys = Object.keys(v.overrides);
  const r = roster.setNodeSettings(hostId,
    { thresholds: keys.length ? v.overrides : null },
    { code: 'node_thresholds', detail: { keys } });
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ ok: true, custom: keys, config: config.publicSnapshot() });
});

app.post('/api/roster/:hostId/probes', requireAdmin, (req, res) => {
  const { hostId } = req.params;
  const plan = (req.body || {}).probes;
  if (!roster.get(hostId)) return res.status(404).json({ error: 'no such node' });
  if (plan === null) {
    const r = roster.setNodeSettings(hostId, { probes: null },
      { code: 'node_probes', detail: { cleared: true } });
    if (!r.ok) return res.status(404).json({ error: r.error });
    return res.json({ ok: true, cleared: true, applies_on: 'agent_reconnect' });
  }
  const errs = config.validateProbes(plan);
  if (errs.length) return res.status(400).json({ error: '该机探测计划不符合约束', errors: errs });
  const r = roster.setNodeSettings(hostId, { probes: plan },
    { code: 'node_probes', detail: {} });
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ ok: true, applies_on: 'agent_reconnect' });
});

// ============================================================
// S2: pairing (design §2) - codes are minted behind the passphrase and are
// never readable back. The plaintext lives in the issuing response and in the
// page that showed it, nowhere else, so a pass-by visitor cannot list them.
// ============================================================
app.post('/api/admin/enroll', requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = roster.issueEnroll({
    ttlMin: Number(b.ttl_minutes) || 15,
    maxUses: b.max_uses === undefined || b.max_uses === null ? 1 : Number(b.max_uses),
    note: b.note,
  });
  // The address the page was opened on is the best guess for what a guest
  // should paste; the pairing UI keeps it editable for the localhost case.
  const host = (req.headers.host || '').split(':')[0] || '127.0.0.1';
  console.log(`[Enroll] code minted (${r.max_uses || '∞'} use(s), ${Math.round((r.expires_at - Date.now()) / 60000)}min)`);
  res.json({ ...r, host, agent_port: AGENT_PORT });
});

app.get('/api/enroll', (req, res) => {
  res.json({
    codes: roster.activeCodes().map(({ code, ...c }) => ({ ...c, code_tail: code.slice(-4) })),
    ingest: ingest.info(),
  });
});

app.post('/api/admin/enroll/revoke', requireAdmin, (req, res) => {
  const b = req.body || {};
  // Either handle works: the plaintext code (only held by the tab that minted
  // it) or the rowid the pairing page always has. Neither is guessable-useful:
  // revoking is a write, and writes need the passphrase.
  const r = b.id !== undefined && b.id !== null
    ? roster.revokeById(b.id)
    : roster.revokeEnroll(String(b.code || ''));
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ ok: true });
});

// S2 §5: the demo switch is a server-side fact, not a client filter - turning
// it off stops the fake frames and retires the props, so their alerts close as
// `retired` (honest wording) instead of lingering as unexplained red.
app.post('/api/admin/demo', requireAdmin, (req, res) => {
  const on = !!(req.body || {}).enabled;
  const r = demoFleet.setEnabled(on);
  res.json({ ok: r.ok, demo: demoFleet.info() });
});

// S5 §5.2: dead pairing codes are the one table that only ever grew. One sweep,
// on the retention clock S3 established - not a second timer.
history.onCleanup((db, now) => roster.purgeExpiredCodes(now));

// ============================================================
// S5 §4: the ZeroTier presence ledger. Read open (it carries no secret: the API
// token never leaves its process), write behind the passphrase. It is a ledger
// of *devices*, deliberately not part of `hosts`/`cluster`/`alerts`, so it can
// neither reach the four-state merge nor the alert sound (S2.6 hard constraint).
// ============================================================
app.get('/api/presence', (req, res) => {
  res.json(ztPresence.info());
});

app.post('/api/presence/alias', requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = roster.setPresenceAlias(b.zt_addr, b.host_id ?? null, b.label ?? null);
  if (!r.ok) return res.status(400).json({ error: r.error });
  console.log(`[Presence] alias ${String(b.zt_addr).slice(0, 4)}… -> ${b.host_id || b.label || '(cleared)'}`);
  res.json({ ok: true, presence: ztPresence.info() });
});

// Production hosting: serve the built client (client/dist) so the whole
// dashboard is available at http://<server>:9101 without vite. Dev mode
// (vite on 5173 + /api proxy) is unaffected when dist/ is absent.
const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');
if (existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir));
  app.get('/', (req, res) => res.sendFile(path.join(distDir, 'index.html')));
  console.log('[Server] Serving client build from client/dist (open http://<this-host>:9101)');
} else {
  console.log('[Server] client/dist not found - API only (use vite dev server for UI)');
}

const clientServer = createServer(app);
const clientWss = new WebSocketServer({ server: clientServer });

clientServer.listen(CLIENT_PORT, '0.0.0.0', () => {
  console.log(`[Server] Client HTTP + WS listening on http://0.0.0.0:${CLIENT_PORT}`);
});

clientWss.on('connection', (ws) => {
  console.log('[Server] Client (frontend) connected');
  ws.send(JSON.stringify(store.getSnapshot()));
  ws.on('close', () => console.log('[Server] Client disconnected'));
});

// Periodic broadcast (also the P5 persistence sampling point - design §3)
setInterval(() => {
  const snapshot = store.getSnapshot();
  history.onBroadcast(snapshot.hosts);
  const payload = JSON.stringify(snapshot);
  for (const client of clientWss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}, BROADCAST_INTERVAL_MS);

console.log('[Server] Host Monitor Server started.');
console.log(`[Server]   Agent endpoint:  ws://localhost:${AGENT_PORT}`);
console.log(`[Server]   Client endpoint: http://localhost:${CLIENT_PORT}`);
