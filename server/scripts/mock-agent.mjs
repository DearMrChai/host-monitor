/**
 * Self-test mock agent: registers fake nodes against the Server (port 9100).
 *
 *   mock-green    (desktop)   all-normal metrics, keeps streaming
 *   mock-warn     (inference) GPU 89C WARN + disk 86% + mem 87%, keeps streaming
 *   mock-silent   (db)        one frame then silence -> OFFLINE after 15s
 *   mock-flap     (laptop)    2-frames-over/2-under CPU bursts, must never fire
 *   mock-crit     (display)   sustained disk 96% -> CRIT active
 *   mock-lag      (other)     server-arm RTT square wave 3<->60ms (P3: debounce + link levels)
 *   mock-gwdown   (other)     gateway 100% loss, server arm healthy (P3: one red arm only)
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

function healthyProbes() {
  const r = (base) => Math.max(0.3, Math.round((base + (Math.random() - 0.5) * 0.6) * 10) / 10)
  return {
    interval_s: 5, window: 10,
    results: [
      { target: 'server', name: 'Server', kind: 'ws', rtt_ms: r(1), loss_pct: 0 },
      { target: 'gateway', name: '网关', kind: 'icmp', rtt_ms: r(1.4), loss_pct: 0 },
      { target: 'infer-142', name: 'infer-142', kind: 'icmp', rtt_ms: r(1.2), loss_pct: 0 },
    ],
  }
}

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
    probes: healthyProbes(),
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
  {
    // bursts of 2 frames over the CPU WARN threshold (80) then 2 under:
    // never reaches the 3-cycle debounce window, must NOT fire
    host_id: 'mock-flap', hostname: 'mock-flap', role: 'laptop', silent: false,
    _n: 0,
    frame: () => {
      const f = MOCKS[3]
      f._n = (f._n + 1) % 4
      const usage = f._n < 2 ? 84 : 76
      return frame('mock-flap', 'mock-flap', usage, 35, [], [{ m: 'C:', t: 256, p: 30 }])
    },
  },
  {
    // sustained disk 96% -> CRIT after the debounce window, crit sound loop path
    host_id: 'mock-crit', hostname: 'mock-crit', role: 'display', silent: false,
    frame: () => {
      const f = frame('mock-crit', 'mock-crit', 18, 44, [], [{ m: 'C:', t: 119, p: 96 }])
      f.disk.worst_percent = 96
      return f
    },
  },
  {
    // P3: server-arm RTT square wave, ~12s healthy then ~12s at 62ms (CRIT>50)
    host_id: 'mock-lag', hostname: 'mock-lag', role: 'other', silent: false,
    _n: 0,
    frame: () => {
      const m = MOCKS[5]
      m._n = (m._n + 1) % 12
      const f = frame('mock-lag', 'mock-lag', 15, 30, [], [{ m: 'C:', t: 200, p: 25 }])
      const laggy = m._n >= 6
      f.probes.results[0] = {
        target: 'server', name: 'Server', kind: 'ws',
        rtt_ms: laggy ? Math.round(62 + Math.random() * 4) : Math.round((2.5 + Math.random()) * 10) / 10,
        loss_pct: 0,
      }
      return f
    },
  },
  {
    // P3: gateway + infer-142 arms 100% loss while server arm stays healthy
    // -> node red from link only; exactly one green arm in the topology view
    host_id: 'mock-gwdown', hostname: 'mock-gwdown', role: 'other', silent: false,
    frame: () => {
      const f = frame('mock-gwdown', 'mock-gwdown', 16, 33, [], [{ m: 'C:', t: 200, p: 28 }])
      f.probes.results[1] = { target: 'gateway', name: '网关', kind: 'icmp', rtt_ms: null, loss_pct: 100 }
      f.probes.results[2] = { target: 'infer-142', name: 'infer-142', kind: 'icmp', rtt_ms: null, loss_pct: 100 }
      return f
    },
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
