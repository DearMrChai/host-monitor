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
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { store } from './store.js';
import { evaluateCluster } from './status.js';

const AGENT_PORT = 9100;
const CLIENT_PORT = 9101;
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
  res.json({ hosts, cluster: evaluateCluster(hosts) });
});

app.get('/api/alerts', (req, res) => {
  res.json(store.getSnapshot().alerts);
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

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

// Periodic broadcast
setInterval(() => {
  const snapshot = JSON.stringify(store.getSnapshot());
  for (const client of clientWss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(snapshot);
  }
}, BROADCAST_INTERVAL_MS);

console.log('[Server] Host Monitor Server started.');
console.log(`[Server]   Agent endpoint:  ws://localhost:${AGENT_PORT}`);
console.log(`[Server]   Client endpoint: http://localhost:${CLIENT_PORT}`);
