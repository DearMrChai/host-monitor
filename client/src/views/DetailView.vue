<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { TopologyRenderer } from '../three/TopologyRenderer.js'
import HudPanel from '../components/HudPanel.vue'
import DrawerV3 from '../components/DrawerV3.vue'
import defaultTopology from '../config/sample-topology.json'
import { STATUS_TEXT, ROLE_LABELS } from '../lib/status.js'

/* V2 node detail, two-layer (P4):
   left = 3D shell (colors/blinks locate the alarm source, click -> V3 drawer)
   right = 2D numeric HUD + per-node alerts. Levels come from the server,
   the frontend never re-thresholds. */

const props = defineProps({
  host: { type: Object, default: null },
  connected: { type: Boolean, default: false },
  alerts: { type: Object, default: () => ({ active: [], resolved: [] }) },
  thresholds: { type: Object, default: () => ({}) },
})
defineEmits(['back'])

const viewport = ref(null)
const topology = ref(defaultTopology)
const hostName = ref('')
const drawerSpec = ref(null)

/* Client-side RTT ring per probe target (~60 frames = 2 min window, P5 will
   replace with server history). */
const rttHistory = ref({})

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
    topo.cpu = { ...topo.cpu, model: metrics.cpu.model || metrics.cpu.model_name || topo.cpu?.model || 'CPU', cores: metrics.cpu.cores }
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

/* 3D pick key -> V3 drawer spec */
function pickToSpec(key) {
  if (key === 'cpu') return { kind: 'cpu' }
  if (key === 'memory') return { kind: 'mem' }
  if (/^gpu\d+$/.test(key)) return { kind: 'gpu', key, index: Number(key.slice(3)) }
  const t = topology.value
  if ((t.storage || []).some(s => s.id === key)) return { kind: 'disk' }
  if ((t.network || []).some(n => n.id === key)) return { kind: 'network' }
  return null
}

function onPick(key) {
  const spec = pickToSpec(key)
  if (spec) drawerSpec.value = spec
}

function buildScene(topoData) {
  renderer?.dispose()
  renderer = null
  if (viewport.value) {
    renderer = new TopologyRenderer(viewport.value, topoData)
    renderer.enableClicks(onPick)
  }
}

/* ---------- Component-level CRIT map for the 3D blink (server-derived) ---------- */

const alarmMap = computed(() => {
  const c = props.host?.status?.components
  if (!c) return undefined
  const map = {
    cpu: c.cpu?.level === 'CRIT',
    mem: c.mem?.level === 'CRIT',
    disk: c.disk?.level === 'CRIT',
  }
  for (const g of c.gpu || []) map[g.id] = g.level === 'CRIT'
  return map
})

const nodeLevel = computed(() => props.host?.status?.level ||
  (props.host?.online ? 'OK' : 'OFFLINE'))

const drawerRtt = computed(() =>
  (drawerSpec.value?.kind === 'link' && rttHistory.value[drawerSpec.value.target]) || [])

function recordRtt(host) {
  const targets = host.status?.components?.link?.targets || []
  for (const t of targets) {
    if (t.rtt_ms == null) continue
    const arr = rttHistory.value[t.target] || (rttHistory.value[t.target] = [])
    arr.push(t.rtt_ms)
    if (arr.length > 120) arr.splice(0, arr.length - 120)
  }
}

function sync3D(host) {
  if (!renderer || !host?.metrics || !host.online) return
  renderer.updateMetrics(host.metrics, alarmMap.value)
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
  sync3D(host)
  if (host.online) recordRtt(host)
})

onMounted(() => {
  if (props.host) {
    hostName.value = props.host.hostname || props.host.host_id
    topology.value = buildTopologyFromMetrics(props.host)
  }
  buildScene(topology.value)
  sync3D(props.host)
})

onBeforeUnmount(() => {
  renderer?.dispose()
  renderer = null
})
</script>

<template>
  <div class="app-layout detail-v2">
    <div class="detail-main">
      <div class="viewport-wrap" :class="{ offline: host && !host.online }">
        <div ref="viewport" class="viewport" />

        <header class="top-bar">
          <div class="tb-left">
            <button class="back-btn" @click="$emit('back')">← 总览</button>
            <span class="conn-dot" :class="{ ok: connected }" />
            <span class="tb-title">Host Monitor</span>
            <span class="tb-host" v-if="hostName">{{ hostName }}</span>
            <span class="tb-role" v-if="host?.role">{{ ROLE_LABELS[host.role] || host.role }}</span>
            <span class="tb-nodelevel" :class="nodeLevel.toLowerCase()">
              {{ STATUS_TEXT[nodeLevel] }}
            </span>
          </div>
          <div class="tb-right">
            <button class="back-btn" v-if="host" @click="drawerSpec = { kind: 'system' }">系统信息</button>
            <span class="tb-status" :class="{ ok: connected }">
              {{ connected ? 'LIVE' : 'OFFLINE' }}
            </span>
          </div>
        </header>

        <div v-if="!host" class="error-overlay">
          <p>节点已丢失</p>
          <p class="hint">该节点不在当前集群列表中</p>
        </div>
        <div v-else-if="!host.online" class="offline-note">
          节点失联{{ host.lastSeen ? ' · 最后上报 ' + new Date(host.lastSeen).toLocaleTimeString() : '' }}
        </div>

        <div class="bus-legend">
          <span class="bl-item"><i class="bl-dot ddr" />DDR</span>
          <span class="bl-item"><i class="bl-dot pcie16" />PCIe x16</span>
          <span class="bl-item"><i class="bl-dot pcie4" />PCIe x4</span>
          <span class="bl-item"><i class="bl-dot nvlink" />NVLink</span>
          <span class="bl-item"><i class="bl-dot dmi" />DMI</span>
        </div>

        <DrawerV3 v-if="host && drawerSpec" :host="host" :spec="drawerSpec"
                  :thresholds="thresholds" :rtt-history="drawerRtt"
                  @close="drawerSpec = null" />
      </div>

      <HudPanel v-if="host" :host="host" :alerts="alerts"
                @drawer="spec => drawerSpec = spec" />
    </div>
  </div>
</template>

<style scoped>
.detail-main { display: flex; width: 100%; height: 100%; min-height: 0; }
.detail-main .viewport-wrap { flex: 1; width: auto; min-width: 0; }
.viewport-wrap.offline .viewport { filter: saturate(.15) opacity(.8); }

.back-btn {
  font: inherit; font-size: 12px; cursor: pointer;
  padding: 4px 12px; border-radius: 14px;
  border: 1px solid var(--border); background: var(--bg-glass); color: var(--text);
  pointer-events: auto;
}
.back-btn:hover { border-color: var(--accent); color: var(--accent); }
.tb-right { display: flex; align-items: center; gap: 10px; }
.tb-role {
  font-size: 10px; color: var(--text2); border: 1px solid var(--border);
  border-radius: 8px; padding: 0 6px; background: var(--bg-glass); pointer-events: auto;
}
.tb-nodelevel {
  font-size: 11px; font-weight: 700; padding: 2px 10px; border-radius: 12px;
  border: 1px solid var(--border); background: var(--bg-glass); pointer-events: auto;
}
.tb-nodelevel.ok { color: #1a7f37; border-color: rgba(30,140,50,.4); }
.tb-nodelevel.warn { color: #9a6700; border-color: rgba(210,153,34,.5); }
.tb-nodelevel.crit { color: #b62324; border-color: rgba(248,81,73,.5); }
.tb-nodelevel.offline { color: var(--text3); }

.offline-note {
  position: absolute; top: 56px; left: 50%; transform: translateX(-50%);
  font-size: 12px; color: var(--text2); z-index: 11;
  background: var(--bg-glass); border: 1px solid var(--border);
  border-radius: 14px; padding: 4px 14px;
}

@media (max-width: 1100px) {
  .detail-main { flex-direction: column; }
  .detail-main :deep(.hud-panel) { width: 100%; border-left: none; border-top: 1px solid var(--border); max-height: 38%; }
}
</style>
