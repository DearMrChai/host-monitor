<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { TopologyRenderer } from '../three/TopologyRenderer.js'
import HudPanel from '../components/HudPanel.vue'
import DrawerV3 from '../components/DrawerV3.vue'
import defaultTopology from '../config/sample-topology.json'
import { STATUS_TEXT, ROLE_LABELS, displayName, isAbsent, formatSeenLast, formatAgo, CLASS_LABELS } from '../lib/status.js'

/* V2 node detail, two-layer (P4):
   left = 3D shell (colors/blinks locate the alarm source, click -> V3 drawer)
   right = 2D numeric HUD + per-node alerts. Levels come from the server,
   the frontend never re-thresholds. */

const props = defineProps({
  host: { type: Object, default: null },
  connected: { type: Boolean, default: false },
  alerts: { type: Object, default: () => ({ active: [], resolved: [] }) },
  thresholds: { type: Object, default: () => ({}) },
  /* Which view opened this detail page. The back button is the only way out
     (the top bar is hidden here), so a label that names the wrong place is a
     real navigation bug, not a cosmetic one. */
  from: { type: String, default: 'overview' },
})
defineEmits(['back'])

const BACK_TEXT = { overview: '← 总览', topology: '← 拓扑', enroll: '← 接入' }
const backText = computed(() => BACK_TEXT[props.from] || BACK_TEXT.overview)

const viewport = ref(null)
const topology = ref(defaultTopology)
const hostName = ref('')
const drawerSpec = ref(null)

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

/* S1b: same grey, right word — a temporary node that left is 离场, not 失联.
   S3b adds the third case: a persistent node the Server has not heard from since
   a restart is 缺席, which is neither of those and must not borrow their words. */
const absent = computed(() => isAbsent(props.host || {}))
const levelText = computed(() => (absent.value
  ? (props.host?.absent_record ? '缺席' : '离场')
  : STATUS_TEXT[nodeLevel.value]))

function sync3D(host) {
  if (!renderer || !host?.metrics || !host.online) return
  renderer.updateMetrics(host.metrics, alarmMap.value)
}

watch(() => props.host, (host) => {
  if (!host) return
  hostName.value = displayName(host)
  const newTopo = buildTopologyFromMetrics(host)
  const topoChanged = JSON.stringify(newTopo) !== JSON.stringify(topology.value)
  if (!renderer || topoChanged) {
    topology.value = newTopo
    buildScene(newTopo)
  }
  sync3D(host)
})

onMounted(() => {
  if (props.host) {
    hostName.value = displayName(props.host)
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
            <button class="back-btn" @click="$emit('back')">{{ backText }}</button>
            <span class="conn-dot" :class="{ ok: connected }" />
            <span class="tb-title">Host Monitor</span>
            <span class="tb-host" v-if="hostName">{{ hostName }}</span>
            <span class="tb-role" v-if="host?.role">{{ ROLE_LABELS[host.role] || host.role }}</span>
            <span class="tb-class" :class="host?.presence_class || 'persistent'"
                  v-if="host">{{ CLASS_LABELS[host.presence_class] || CLASS_LABELS.persistent }}</span>
            <span class="tb-nodelevel" :class="nodeLevel.toLowerCase()">
              {{ levelText }}
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
          <p>节点暂不可见</p>
          <p class="hint">它不在 Server 当前的主机列表里（可能已被退役，或 Server 重启后 Agent 尚未重连）<br>
            告警按最后已知状态保留，不会因此被判成"已恢复"</p>
        </div>
        <div v-else-if="absent" class="offline-note">
          {{ host.absent_record
            ? `常驻节点已缺席 · 上次在场 ${formatAgo(host.last_seen)}（计入在线率，不计入健康度）`
            : `临时节点已离场 · 上次在场 ${formatSeenLast(host.last_seen)}（不报警、不计入在线率）` }}
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
                  :thresholds="thresholds"
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
/* Class is never implicit (S1 design §9): 常驻/临时 must be readable here too. */
.tb-class {
  font-size: 10px; border-radius: 8px; padding: 0 6px; pointer-events: auto;
  color: #1a7f37; background: rgba(30,140,50,.10);
}
.tb-class.ephemeral {
  color: var(--text2); background: rgba(0,0,0,.05); border: 1px dashed var(--border);
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
