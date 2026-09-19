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
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { store } from './store.js';
import { evaluateCluster } from './status.js';
import { history } from './history.js';
import { alertEngine } from './alerts.js';
import { roster, CLASSES } from './roster.js';

// Overridable so the self-test can run a throwaway Server beside a live one.
const AGENT_PORT = Number(process.env.HM_AGENT_PORT) || 9100;
const CLIENT_PORT = Number(process.env.HM_CLIENT_PORT) || 9101;
const BROADCAST_INTERVAL_MS = 2000;

// Star-probe plan pushed to every Agent in the register ack (P3).
// Real targets live in probes.json (gitignored); copy probes.example.json
// to start. Missing file -> Agents fall back to Server-only probing.
let probePlan = null;
try {
  probePlan = JSON.parse(
    readFileSync(new URL('./config/probes.json', import.meta.url), 'utf8'));
} catch {
  console.log('[Server] No probes.json, agents will probe the Server arm only');
}

// P5: replay persisted active alerts so a restart doesn't lose them (design §7).
alertEngine.restoreActive(history.activeAlertRows());

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
        hostId = msg.host_id;
        store.register(hostId, {
          hostname: msg.hostname,
          platform: msg.platform,
          role: msg.role,
          topology: msg.topology,  // Pass topology through
          // S1 §1: carried and stored for evidence, deliberately NOT validated
          // yet. Enforcing the enrol token would require touching the three
          // production Agents, which the iteration cadence rule forbids until
          // S2 (where the Agent config and the deployable are rebuilt anyway).
          token: msg.token,
          agent_version: msg.agent_version,
          fingerprint: msg.fingerprint,
          kind: msg.kind,
        });
        console.log(`[Server] Agent registered: ${hostId} (${msg.hostname}) role=${msg.role || 'other'}`);
        if (msg.topology) {
          const t = msg.topology;
          console.log(`[Server]   Topology: ${t.cpu?.model}, ` +
            `${t.memory?.sticks?.length || 0} DIMM, ` +
            `${t.gpu?.length || 0} GPU`);
        }
        ws.send(JSON.stringify({ type: 'registered', host_id: hostId, probe_plan: probePlan }));
      } else if (msg.type === 'metrics') {
        hostId = msg.host_id || hostId;
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
function requireAdmin(req, res, next) {
  if (!roster.hasPassphrase()) {
    return res.status(403).json({ error: '未设置管理口令，写操作已禁用' });
  }
  if (!roster.checkPassphrase(req.get('x-hm-admin'))) {
    return res.status(403).json({ error: '口令不正确' });
  }
  return next();
}

app.post('/api/admin/passphrase', (req, res) => {
  const { passphrase, old } = req.body || {};
  const r = roster.setPassphrase(passphrase, old);
  if (!r.ok) return res.status(400).json({ error: r.error });
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
