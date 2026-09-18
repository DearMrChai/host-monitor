<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { TopologyRenderer } from './three/TopologyRenderer.js'
import defaultTopology from './config/sample-topology.json'

const SERVER_WS = 'ws://localhost:9101'
const SERVER_API = '/api/hosts'

const viewport = ref(null)
const connected = ref(false)
const hostData = ref(null)
const topology = ref(defaultTopology)
const hostName = ref('')
const errorMsg = ref('')

let renderer = null
let ws = null
let reconnectTimer = null

/* ---------- Helpers ---------- */

function barClass(val) {
  if (val == null) return ''
  if (val > 90) return 'crit'
  if (val > 70) return 'warn'
  return ''
}

/* ---------- Topology from agent ---------- */

function buildTopologyFromMetrics(host) {
  if (!host) return defaultTopology

  // Use agent-reported topology if available
  if (host.topology) {
    const t = host.topology
    // Add PCH if not detected but host has PCH-connected devices
    if (!t.pch) {
      const hasPchDevices = (t.storage || []).some(s => s.via === 'pch') ||
                            (t.network || []).some(n => n.via === 'pch')
      if (hasPchDevices) {
        t.pch = { id: 'pch0', model: 'PCH', link_to_cpu: 'DMI' }
      }
    }
    return t
  }

  // Fallback: build from metrics
  const metrics = host.metrics
  if (!metrics) return defaultTopology

  const topo = { ...defaultTopology }
  if (metrics.cpu) {
    topo.cpu = { ...topo.cpu, model: metrics.cpu.model || topo.cpu?.model || 'CPU', cores: metrics.cpu.cores }
  }
  if (metrics.memory) {
    const totalGb = metrics.memory.total_gb || 16
    const stickCount = metrics.memory.sticks?.length || Math.max(1, Math.round(totalGb / 8))
    const stickSize = Math.round(totalGb / stickCount)
    topo.memory = {
      channels: Math.min(stickCount, 4),
      type: 'DDR4',
      sticks: Array.from({ length: Math.min(stickCount, 4) }, (_, i) => ({
        slot: `DIMM_${i + 1}`, size_gb: stickSize, freq_mhz: 2666,
      })),
    }
  }
  if (metrics.gpu?.length) {
    topo.gpu = metrics.gpu.map((g, i) => ({
      id: `gpu${i}`, slot: `PCIe_x16_${i}`,
      model: g.name || `GPU ${i}`,
      vram_gb: g.vram_total_mb ? Math.round(g.vram_total_mb / 1024) : 4,
    }))
  }
  return topo
}

/* ---------- Scene ---------- */

function buildScene(topoData) {
  renderer?.dispose()
  renderer = null
  if (viewport.value) {
    renderer = new TopologyRenderer(viewport.value, topoData)
  }
}

/* ---------- WebSocket ---------- */

function connect() {
  if (ws && ws.readyState <= 1) return
  try {
    ws = new WebSocket(SERVER_WS)

    ws.onopen = () => {
      connected.value = true
      errorMsg.value = ''
    }

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === 'snapshot' && msg.hosts?.length) {
          const host = msg.hosts[0]
          hostData.value = host
          hostName.value = host.hostname || host.host_id

          // Build/update topology
          const newTopo = buildTopologyFromMetrics(host)
          const topoChanged = JSON.stringify(newTopo) !== JSON.stringify(topology.value)
          if (!renderer || topoChanged) {
            topology.value = newTopo
            buildScene(newTopo)
          }

          // Push live metrics to renderer
          if (host.metrics && renderer) {
            renderer.updateMetrics(host.metrics)
          }
        }
      } catch (e) {
        console.error('[Client] Parse error:', e)
      }
    }

    ws.onclose = () => {
      connected.value = false
      scheduleReconnect()
    }

    ws.onerror = () => {
      errorMsg.value = 'Cannot connect to monitoring server'
    }
  } catch (e) {
    errorMsg.value = 'WebSocket connection failed'
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, 3000)
}

/* ---------- Lifecycle ---------- */

onMounted(async () => {
  buildScene(topology.value)

  // Initial REST fetch
  try {
    const res = await fetch(SERVER_API)
    if (res.ok) {
      const data = await res.json()
      if (data.hosts?.length) {
        const host = data.hosts[0]
        hostData.value = host
        hostName.value = host.hostname || host.host_id
        const topo = buildTopologyFromMetrics(host)
        topology.value = topo
        buildScene(topo)
        if (host.metrics) renderer?.updateMetrics(host.metrics)
      }
    }
  } catch (e) { /* will use WS */ }

  connect()
})

onBeforeUnmount(() => {
  if (ws) { ws.onclose = null; ws.close() }
  if (reconnectTimer) clearTimeout(reconnectTimer)
  renderer?.dispose()
})
</script>

<template>
  <div class="app-layout">
    <div class="viewport-wrap">
      <div ref="viewport" class="viewport" />

      <!-- Top bar -->
      <header class="top-bar">
        <div class="tb-left">
          <span class="conn-dot" :class="{ ok: connected }" />
          <span class="tb-title">Host Monitor</span>
          <span class="tb-host" v-if="hostName">{{ hostName }}</span>
          <span class="tb-type" v-if="hostData?.topology?.host_type">
            {{ hostData.topology.host_type }}
          </span>
        </div>
        <div class="tb-right">
          <span class="tb-status" :class="{ ok: connected }">
            {{ connected ? 'LIVE' : 'OFFLINE' }}
          </span>
        </div>
      </header>

      <!-- Error -->
      <div v-if="errorMsg && !connected" class="error-overlay">
        <p>{{ errorMsg }}</p>
        <p class="hint">Ensure server is running: cd server && npm run dev</p>
      </div>

      <!-- Metrics HUD -->
      <div class="metrics-hud" v-if="hostData?.metrics && hostData?.online">
        <div class="hud-title">{{ hostData.metrics.cpu?.model || hostName }}</div>
        <div class="hud-row">
          <span class="hud-label">CPU</span>
          <div class="hud-bar">
            <div class="hud-fill" :style="{ width: (hostData.metrics.cpu?.usage_percent || 0) + '%' }"
                 :class="barClass(hostData.metrics.cpu?.usage_percent)" />
          </div>
          <span class="hud-val">{{ hostData.metrics.cpu?.usage_percent?.toFixed(1) || 0 }}%</span>
        </div>
        <div class="hud-row" v-if="hostData.metrics.gpu?.length">
          <span class="hud-label">GPU</span>
          <div class="hud-bar">
            <div class="hud-fill gpu" :style="{ width: (hostData.metrics.gpu[0]?.usage_percent || 0) + '%' }"
                 :class="barClass(hostData.metrics.gpu[0]?.usage_percent)" />
          </div>
          <span class="hud-val">{{ hostData.metrics.gpu[0]?.usage_percent != null ? hostData.metrics.gpu[0].usage_percent + '%' : 'N/A' }}</span>
        </div>
        <div class="hud-row">
          <span class="hud-label">RAM</span>
          <div class="hud-bar">
            <div class="hud-fill ram" :style="{ width: (hostData.metrics.memory?.percent || 0) + '%' }"
                 :class="barClass(hostData.metrics.memory?.percent)" />
          </div>
          <span class="hud-val">{{ hostData.metrics.memory?.used_gb?.toFixed(1) || 0 }}/{{ hostData.metrics.memory?.total_gb?.toFixed(0) || 0 }}GB</span>
        </div>
        <div class="hud-row">
          <span class="hud-label">NET</span>
          <span class="hud-net">
            <span class="net-down">&darr;{{ hostData.metrics.network?.download_mbps?.toFixed(1) || 0 }}</span>
            <span class="net-up">&uarr;{{ hostData.metrics.network?.upload_mbps?.toFixed(1) || 0 }}</span>
            <span class="net-unit">Mbps</span>
          </span>
        </div>
        <div class="hud-row" v-if="hostData.metrics.gpu?.[0]?.temperature_c">
          <span class="hud-label">TEMP</span>
          <span class="hud-val" :class="{ crit: hostData.metrics.gpu[0].temperature_c > 80 }">
            GPU {{ hostData.metrics.gpu[0].temperature_c }}&deg;C
          </span>
          <span class="hud-val" v-if="hostData.metrics.cpu?.temperature_c">
            CPU {{ hostData.metrics.cpu.temperature_c }}&deg;C
          </span>
        </div>
      </div>

      <!-- Bus legend -->
      <div class="bus-legend">
        <span class="bl-item"><i class="bl-dot ddr" />DDR</span>
        <span class="bl-item"><i class="bl-dot pcie16" />PCIe x16</span>
        <span class="bl-item"><i class="bl-dot pcie4" />PCIe x4</span>
        <span class="bl-item"><i class="bl-dot nvlink" />NVLink</span>
        <span class="bl-item"><i class="bl-dot dmi" />DMI</span>
      </div>
    </div>
  </div>
</template>
