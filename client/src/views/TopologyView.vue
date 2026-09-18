<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { ClusterTopologyRenderer } from '../three/ClusterTopologyRenderer.js'
import { sortHostsForOverview, deviceLevel } from '../lib/status.js'

/* V1.5 cluster topology (P3): 3D star view of link quality.
   Top cluster bar / alert banner live in the App shell (shared with V1). */

const props = defineProps({
  hosts: { type: Array, default: () => [] },
})
const emit = defineEmits(['open'])

const viewport = ref(null)
let renderer = null

function viewModel() {
  return sortHostsForOverview(props.hosts).map(h => ({
    id: h.host_id,
    name: h.hostname || h.host_id,
    deviceLevel: deviceLevel(h),
    linkLevel: h.status?.components?.link?.level || null,
    online: !!h.online,
    links: (h.status?.components?.link?.targets || []).map(t => ({
      key: t.target, name: t.name, rtt: t.rtt_ms, loss: t.loss_pct, level: t.level,
    })),
  }))
}

onMounted(() => {
  renderer = new ClusterTopologyRenderer(viewport.value)
  renderer.enableClicks()
  renderer.onNodeClick = (id) => emit('open', id)
  renderer.update(viewModel())
})

watch(() => props.hosts, () => renderer?.update(viewModel()))

onBeforeUnmount(() => {
  renderer?.dispose()
  renderer = null
})
</script>

<template>
  <div class="topology">
    <div ref="viewport" class="tp-viewport" />
    <div class="tp-legend">
      <span class="lg"><i class="lg-dot ok" />链路正常</span>
      <span class="lg"><i class="lg-dot warn" />延迟/丢包警告</span>
      <span class="lg"><i class="lg-dot crit" />严重</span>
      <span class="lg"><i class="lg-dash" />断链 / 无数据</span>
      <span class="lg tp-hint">方块=设备状态 · 底座=链路 · 脉冲速率=延迟倒数 · 点击方块钻取</span>
    </div>
    <div v-if="!hosts.length" class="tp-empty">暂无节点，等待 Agent 上报…</div>
  </div>
</template>

<style scoped>
.topology { height: 100%; position: relative; overflow: hidden; }
.tp-viewport { position: absolute; inset: 0; }
.tp-legend {
  position: absolute; left: 14px; bottom: 12px; z-index: 5;
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  font-size: 11px; color: var(--text2);
  background: var(--bg-glass); border: 1px solid var(--border);
  border-radius: 8px; padding: 6px 12px;
}
.lg { display: inline-flex; align-items: center; gap: 5px; }
.lg-dot { width: 8px; height: 8px; border-radius: 50%; }
.lg-dot.ok { background: var(--green); }
.lg-dot.warn { background: var(--orange); }
.lg-dot.crit { background: var(--red); }
.lg-dash { width: 18px; border-top: 2px dashed var(--text3); }
.tp-hint { color: var(--text3); }
.tp-empty {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: var(--text3); font-size: 13px;
}
</style>
