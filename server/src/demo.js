/**
 * Demo fleet (S2 §5): in-process simulated nodes, so a screenshot of the board
 * can show what a 7-node fleet looks like without inventing hardware.
 * Contract: S2-细化设计.md §5.
 *
 * Three rules make this honest rather than a lie with nice colours:
 *   1. host_id always starts `sim-` and the display name is forced to the
 *      `模拟-` prefix by roster (S1 §6) - whoever starts the demo cannot name a
 *      prop "infer-142".
 *   2. demo nodes are excluded from cluster health, the online denominator and
 *      aggregate load (status.js), because "我的集群 3/3 健康" must stay true
 *      with the props running. They do appear in the alert panel - a prop alert
 *      explains itself by its name, and it is what the alert UI is for.
 *   3. the switch is a real off: the generator stops and the nodes are retired,
 *      so their data stops entering the history DB and any leftover alert
 *      closes as `retired` instead of decaying into a fake recovery.
 *
 * `store` is injected (attach) rather than imported: store.js reads this
 * module's state for every snapshot, and the codebase has no import cycles.
 */
import { roster } from './roster.js'

const TICK_MS = 2000

const jitter = (base, span = 6) =>
  Math.min(99, Math.max(1, base + Math.round((Math.random() - 0.5) * span)))

function frame(hostId, hostname, opts) {
  return {
    type: 'metrics',
    host_id: hostId,
    hostname,
    platform: opts.platform,
    timestamp: Date.now(),
    agent_version: 'demo-1.0',
    cpu: {
      usage_percent: jitter(opts.cpu), cores: opts.cores, cores_physical: Math.round(opts.cores / 2),
      freq_mhz: opts.freq, temperature_c: jitter(opts.cpu + 32, 10),
      per_core: Array.from({ length: opts.cores }, () => jitter(opts.cpu, 40)),
    },
    memory: {
      total_gb: opts.memTotal, used_gb: Math.round(opts.memTotal * opts.mem) / 100,
      percent: opts.mem, available_gb: Math.round(opts.memTotal * (100 - opts.mem)) / 100, sticks: [],
    },
    network: {
      upload_mbps: Math.round(Math.random() * 60) / 10, download_mbps: Math.round(Math.random() * 400) / 10,
      total_sent_gb: 12.3, total_recv_gb: 45.6,
    },
    gpu: (opts.gpu || []).map((g, i) => ({
      index: i, name: g.name, usage_percent: g.usage, mem_percent: null,
      vram_used_mb: g.vram, vram_total_mb: g.vramTotal, temperature_c: g.temp,
    })),
    disk: {
      partitions: opts.disks.map(p => ({
        mountpoint: p.m, fstype: p.fs || 'ext4', total_gb: p.t,
        used_gb: Math.round(p.t * p.p) / 100, percent: p.p,
      })),
      worst_percent: Math.max(...opts.disks.map(p => p.p)),
      total_gb: opts.disks.reduce((a, p) => a + p.t, 0),
      io: { read_mb_s: Math.round(Math.random() * 400) / 10, write_mb_s: Math.round(Math.random() * 250) / 10 },
    },
    system: { uptime_seconds: opts.uptime, load_avg: [opts.cpu / 40, opts.cpu / 55, opts.cpu / 70] },
  }
}

/** The four props: healthy, busy-but-fine, one WARN, and one absent ephemeral. */
const SCENARIO = [
  {
    host_id: 'sim-vectordb', hostname: 'sim-vectordb', display: '模拟-向量库机',
    role: 'db', presence_class: 'persistent',
    spec: () => ({ platform: 'Ubuntu 24.04', cores: 16, freq: 3400, cpu: 24, mem: 48, memTotal: 64,
      gpu: [{ name: 'Demo L4', usage: 12, vram: 2048, vramTotal: 24576, temp: 47 }],
      disks: [{ m: '/', t: 931, p: 41 }, { m: '/data', t: 3726, p: 37 }], uptime: 864000 }),
  },
  {
    host_id: 'sim-game', hostname: 'sim-game', display: '模拟-朋友的游戏机',
    role: 'desktop', presence_class: 'persistent',
    spec: () => ({ platform: 'Windows 11', cores: 20, freq: 4900, cpu: 62, mem: 71, memTotal: 32,
      gpu: [{ name: 'Demo RTX', usage: 97, vram: 7400, vramTotal: 16384, temp: 74 }],
      disks: [{ m: 'C:', t: 931, p: 55, fs: 'NTFS' }, { m: 'D:', t: 1863, p: 78, fs: 'NTFS' }], uptime: 43200 }),
  },
  {
    // One sustained disk WARN (thresholds: warn 80 / crit 90) - a demo of the
    // alert panel that does not require shouting about a burning machine.
    host_id: 'sim-media', hostname: 'sim-media', display: '模拟-影音服务器',
    role: 'display', presence_class: 'persistent',
    spec: () => ({ platform: 'Debian 12', cores: 8, freq: 2800, cpu: 9, mem: 33, memTotal: 16,
      disks: [{ m: '/', t: 228, p: 44 }, { m: '/media', t: 7450, p: 86 }], uptime: 1296000 }),
  },
  {
    // One frame then silence: the ABSENT card path (ephemeral offline), which is
    // the single best demo of what the roster layer bought us.
    host_id: 'sim-tmpnote', hostname: 'sim-tmpnote', display: '模拟-临时笔记本',
    role: 'laptop', presence_class: 'ephemeral', speak_once: true,
    spec: () => ({ platform: 'Windows 11', cores: 12, freq: 2600, cpu: 15, mem: 52, memTotal: 16,
      disks: [{ m: 'C:', t: 476, p: 62, fs: 'NTFS' }], uptime: 7200 }),
  },
]

class DemoFleet {
  constructor() {
    this.enabled = false
    this.timer = null
    this.spoke = new Set()
    this.phase = 0
    this.store = null
  }

  /** index.js wires the store in; see the module header for why. */
  attach(store) {
    this.store = store
    return this
  }

  #requireStore() {
    if (!this.store) throw new Error('[Demo] demoFleet.attach(store) was never called')
    return this.store
  }

  /**
   * @param {boolean} on
   * @param {{persist?:boolean}} opts - the HTTP toggle persists into roster
   *   meta so a Server restart keeps the state the user last chose.
   */
  setEnabled(on, { persist = true } = {}) {
    const changed = on !== this.enabled
    this.enabled = on
    if (persist) roster.setDemoEnabled(on)
    if (!changed) return { ok: true, enabled: on }

    if (on) {
      this.spoke.clear()
      for (const s of SCENARIO) {
        roster.ensure(s.host_id, { hostname: s.hostname, kind: 'demo', role: s.role, confirmed: true })
        roster.setDisplay(s.host_id, s.display)
        roster.setClass(s.host_id, s.presence_class, { confirmed: true })
      }
      this.start()
      console.log(`[Demo] Demo fleet ON (${SCENARIO.length} nodes, 模拟- prefixed)`)
    } else {
      this.stop()
      // Retire, do not merely forget: that closes their alerts as `retired`
      // (S1b), keeps stale props off the board, and stops their samples reaching
      // the history DB - while the rows stay queryable under sim-*.
      for (const s of SCENARIO) {
        if (roster.get(s.host_id)) roster.setClass(s.host_id, 'retired', { confirmed: true })
        this.#requireStore().markDisconnected(s.host_id)
      }
      console.log('[Demo] Demo fleet OFF (nodes retired, generation stopped)')
    }
    return { ok: true, enabled: on }
  }

  start() {
    this.stop()
    // Immediate first frame: enabling the demo from the pairing page should
    // paint within the same second, not after a 2s gap.
    this.tick()
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  tick(now = Date.now()) {
    if (!this.enabled) return
    const store = this.#requireStore()
    this.phase += 1
    for (const s of SCENARIO) {
      if (s.speak_once) {
        if (this.spoke.has(s.host_id)) continue
        this.spoke.add(s.host_id)
      }
      const spec = s.spec()
      // Gentle breathing so the curves look alive rather than like a wall.
      const wave = Math.round(Math.sin(this.phase / 12) * 4)
      spec.cpu = Math.max(2, spec.cpu + wave)
      spec.mem = Math.min(97, Math.max(5, spec.mem + Math.round(wave / 2)))
      store.register(s.host_id, {
        hostname: s.hostname, platform: spec.platform, role: s.role,
        kind: 'demo', agent_version: 'demo-1.0', confirmed: true,
      })
      store.updateMetrics(s.host_id, { ...frame(s.host_id, s.hostname, spec), type: 'metrics' })
    }
    // last_seen needs no call here: updateMetrics -> roster.markSeen covers it.
  }

  /** Boot-time pre-arm: HM_DEMO=1 (the runtime switch is the pairing page). */
  autoStart() {
    const want = String(process.env.HM_DEMO || '').trim().toLowerCase()
    if (want === '1' || want === 'on' || want === 'true') return this.setEnabled(true, { persist: true })
    if (roster.demoEnabledStored() === true) return this.setEnabled(true, { persist: false })
    return { ok: true, enabled: false }
  }

  ids() { return SCENARIO.map((s) => s.host_id) }
  info() {
    return { enabled: this.enabled, count: this.enabled ? SCENARIO.length : 0, ids: this.ids() }
  }
}

export const demoFleet = new DemoFleet()
