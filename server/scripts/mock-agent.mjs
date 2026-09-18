/**
 * P1 self-test mock agent: registers 3 fake nodes against the Server (port 9100).
 *
 *   mock-green  (desktop)   all-normal metrics, keeps streaming
 *   mock-warn   (inference) GPU 89C WARN + disk 86% + mem 87%, keeps streaming
 *   mock-silent (db)        one frame then silence -> OFFLINE after 15s
 *
 * Usage: node scripts/mock-agent.mjs [--server ws://localhost:9100] [--interval 2]
 */
import WebSocket from 'ws'

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const SERVER = arg('server', 'ws://localhost:9100')
const INTERVAL = Number(arg('interval', 2)) * 1000

const jitter = (base, span = 6) =>
  Math.min(99, Math.max(1, base + Math.round((Math.random() - 0.5) * span)))

function frame(hostId, hostname, cpu, mem, gpus, diskParts) {
  return {
    type: 'metrics',
    host_id: hostId,
    hostname,
    platform: 'Mock 1.0',
    timestamp: Date.now(),
    cpu: { usage_percent: jitter(cpu), cores: 8, cores_physical: 4, freq_mhz: 3200, temperature_c: jitter(55, 8) },
    memory: { total_gb: 32, used_gb: Math.round(32 * mem) / 100, percent: mem, available_gb: Math.round(32 * (100 - mem)) / 100, sticks: [] },
    network: { upload_mbps: jitter(20, 10) / 10, download_mbps: jitter(80, 20) / 10, total_sent_gb: 12.3, total_recv_gb: 45.6 },
    gpu: gpus.map((g, i) => ({
      index: i, name: g.name, usage_percent: g.usage, mem_percent: null,
      vram_used_mb: g.vram_used, vram_total_mb: 8192, temperature_c: g.temp,
    })),
    disk: {
      partitions: diskParts.map(p => ({
        mountpoint: p.m, fstype: 'NTFS',
        total_gb: p.t, used_gb: Math.round(p.t * p.p) / 100, percent: p.p,
      })),
      worst_percent: Math.max(...diskParts.map(p => p.p)),
      total_gb: diskParts.reduce((a, p) => a + p.t, 0),
      used_gb: Math.round(diskParts.reduce((a, p) => a + p.t * p.p, 0) / 100 * 10) / 10,
    },
    system: { uptime_seconds: 345600, load_avg: [1.2, 0.9, 0.8] },
  }
}

const MOCKS = [
  {
    host_id: 'mock-green', hostname: 'mock-green', role: 'desktop', silent: false,
    frame: () => frame('mock-green', 'mock-green', 22, 41,
      [{ name: 'Mock GPU', usage: 15, vram_used: 1024, temp: 52 }],
      [{ m: 'C:', t: 476, p: 55 }, { m: 'D:', t: 931, p: 40 }]),
  },
  {
    host_id: 'mock-warn', hostname: 'mock-warn', role: 'inference', silent: false,
    frame: () => {
      const f = frame('mock-warn', 'mock-warn', 68, 87,
        [{ name: 'Mock A100-0', usage: 64, vram_used: 6000, temp: 78 },
         { name: 'Mock A100-1', usage: 91, vram_used: 7600, temp: 89 }],
        [{ m: 'C:', t: 476, p: 86 }])
      f.cpu.temperature_c = 71
      return f
    },
  },
  {
    host_id: 'mock-silent', hostname: 'mock-silent', role: 'db', silent: true,
    frame: () => frame('mock-silent', 'mock-silent', 12, 30, [], [{ m: 'C:', t: 200, p: 22 }]),
  },
]

const ws = new WebSocket(SERVER)
const sentSilent = new Set()

ws.on('open', () => {
  console.log(`[MockAgent] Connected to ${SERVER}`)
  for (const mock of MOCKS) {
    ws.send(JSON.stringify({
      type: 'register', host_id: mock.host_id, hostname: mock.hostname,
      platform: 'Mock 1.0', role: mock.role, topology: null,
    }))
    console.log(`[MockAgent] Registered ${mock.host_id} (role=${mock.role}${mock.silent ? ', will go silent' : ''})`)
  }
})

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.type === 'registered') console.log(`[MockAgent] Server ack: ${msg.host_id}`)
})

ws.on('error', (e) => { console.error('[MockAgent] Error:', e.message); process.exit(1) })
ws.on('close', () => { console.log('[MockAgent] Closed'); process.exit(0) })

setInterval(() => {
  if (ws.readyState !== WebSocket.OPEN) return
  for (const mock of MOCKS) {
    if (mock.silent) {
      if (!sentSilent.has(mock.host_id)) {
        sentSilent.add(mock.host_id)
        ws.send(JSON.stringify(mock.frame()))
        console.log(`[MockAgent] ${mock.host_id}: one frame sent, now silent (OFFLINE in ${15}s)`)
      }
      continue
    }
    ws.send(JSON.stringify(mock.frame()))
  }
}, INTERVAL)
