<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { TopologyRenderer } from '../three/TopologyRenderer.js'
import defaultTopology from '../config/sample-topology.json'
import { LEVEL_RANK } from '../lib/status.js'

/* 3D single-host detail view. P1 scope: extracted from App.vue unchanged in
   rendering logic (double-layer HUD rework is P4). Only data input changed:
   host object now comes from the App shell's WebSocket instead of local WS. */

const props = defineProps({
  host: { type: Object, default: null },
  connected: { type: Boolean, default: false },
})
defineEmits(['back'])

const viewport = ref(null)
const topology = ref(defaultTopology)
const hostName = ref('')

let renderer = null

function buildTopologyFromMetrics(host) {
  if (!host) return defaultTopology

  if (host.topology) {
    const t = host.topology
    if (!t.pch) {
      const hasPchDevices = (t.storage || []).some(s => s.via === 'pch') ||
                            (t.network || []).some(n => n.via === 'pch')
      if (hasPchDevices) {
        t.pch = { id: 'pch0', model: 'PCH', link_to_cpu: 'DMI' }
      }
    }
    return t
  }

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

function buildScene(topoData) {
  renderer?.dispose()
  renderer = null
  if (viewport.value) {
    renderer = new TopologyRenderer(viewport.value, topoData)
  }
}

/* ---------- Four-state colors for HUD (server-derived, not re-thresholded) ---------- */

function worstOf(levels) {
  return levels.filter(Boolean).reduce(
    (a, l) => (a && LEVEL_RANK[a] >= LEVEL_RANK[l] ? a : l), null)
}

function hudClass(level) {
  if (level === 'CRIT') return 'crit'
  if (level === 'WARN') return 'warn'
  return ''
}

const comp = () => props.host?.status?.components || {}

/* ---------- Host updates ---------- */

function alarmOverride(host) {
  return host?.status ? host.status.level === 'CRIT' : undefined
}

watch(() => props.host, (host) => {
  if (!host) return
  hostName.value = host.hostname || host.host_id
  const newTopo = buildTopologyFromMetrics(host)
  const topoChanged = JSON.stringify(newTopo) !== JSON.stringify(topology.value)
  if (!renderer || topoChanged) {
    topology.value = newTopo
    buildScene(newTopo)
  }
  if (host.metrics && renderer) {
    renderer.updateMetrics(host.metrics, alarmOverride(host))
  }
})

onMounted(() => {
  buildScene(topology.value)
  if (props.host) {
    hostName.value = props.host.hostname || props.host.host_id
    const topo = buildTopologyFromMetrics(props.host)
    topology.value = topo
    buildScene(topo)
    if (props.host.metrics) renderer?.updateMetrics(props.host.metrics, alarmOverride(props.host))
  }
})

onBeforeUnmount(() => {
  renderer?.dispose()
  renderer = null
})
</script>

<template>
  <div class="app-layout">
    <div class="viewport-wrap">
      <div ref="viewport" class="viewport" />

      <!-- Top bar -->
      <header class="top-bar">
        <div class="tb-left">
          <button class="back-btn" @click="$emit('back')">← 总览</button>
          <span class="conn-dot" :class="{ ok: connected }" />
          <span class="tb-title">Host Monitor</span>
          <span class="tb-host" v-if="hostName">{{ hostName }}</span>
          <span class="tb-type" v-if="host?.topology?.host_type">
            {{ host.topology.host_type }}
          </span>
        </div>
        <div class="tb-right">
          <span class="tb-status" :class="{ ok: connected }">
            {{ connected ? 'LIVE' : 'OFFLINE' }}
          </span>
        </div>
      </header>

      <!-- Node lost -->
      <div v-if="!host" class="error-overlay">
        <p>节点已丢失</p>
        <p class="hint">该节点不在当前集群列表中</p>
      </div>

      <!-- Metrics HUD -->
      <div class="metrics-hud" v-if="host?.metrics && host?.online">
        <div class="hud-title">{{ host.metrics.cpu?.model || hostName }}</div>
        <div class="hud-row">
          <span class="hud-label">CPU</span>
          <div class="hud-bar">
            <div class="hud-fill" :style="{ width: (host.metrics.cpu?.usage_percent || 0) + '%' }"
                 :class="hudClass(comp().cpu?.level)" />
          </div>
          <span class="hud-val">{{ host.metrics.cpu?.usage_percent?.toFixed(1) || 0 }}%</span>
        </div>
        <div class="hud-row" v-if="host.metrics.gpu?.length">
          <span class="hud-label">GPU</span>
          <div class="hud-bar">
            <div class="hud-fill gpu" :style="{ width: (host.metrics.gpu[0]?.usage_percent || 0) + '%' }"
                 :class="hudClass(worstOf((comp().gpu || []).map(g => g.level)))" />
          </div>
          <span class="hud-val">{{ host.metrics.gpu[0]?.usage_percent != null ? host.metrics.gpu[0].usage_percent + '%' : 'N/A' }}</span>
        </div>
        <div class="hud-row">
          <span class="hud-label">RAM</span>
          <div class="hud-bar">
            <div class="hud-fill ram" :style="{ width: (host.metrics.memory?.percent || 0) + '%' }"
                 :class="hudClass(comp().mem?.level)" />
          </div>
          <span class="hud-val">{{ host.metrics.memory?.used_gb?.toFixed(1) || 0 }}/{{ host.metrics.memory?.total_gb?.toFixed(0) || 0 }}GB</span>
        </div>
        <div class="hud-row">
          <span class="hud-label">NET</span>
          <span class="hud-net">
            <span class="net-down">&darr;{{ host.metrics.network?.download_mbps?.toFixed(1) || 0 }}</span>
            <span class="net-up">&uarr;{{ host.metrics.network?.upload_mbps?.toFixed(1) || 0 }}</span>
            <span class="net-unit">Mbps</span>
          </span>
        </div>
        <div class="hud-row" v-if="host.metrics.gpu?.[0]?.temperature_c">
          <span class="hud-label">TEMP</span>
          <span class="hud-val" :class="hudClass(worstOf((comp().gpu || []).map(g => g.level)))">
            GPU {{ host.metrics.gpu[0].temperature_c }}&deg;C
          </span>
          <span class="hud-val" v-if="host.metrics.cpu?.temperature_c">
            CPU {{ host.metrics.cpu.temperature_c }}&deg;C
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

<style scoped>
.back-btn {
  font: inherit; font-size: 12px; cursor: pointer;
  padding: 4px 12px; border-radius: 14px;
  border: 1px solid var(--border); background: var(--bg-glass); color: var(--text);
  pointer-events: auto;
}
.back-btn:hover { border-color: var(--accent); color: var(--accent); }
.hud-val.crit { color: var(--red); font-weight: 600; }
.hud-val.warn { color: var(--orange); }
</style>
