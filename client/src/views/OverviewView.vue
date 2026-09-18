<script setup>
import { computed } from 'vue'
import ClusterBar from '../components/ClusterBar.vue'
import AlertBanner from '../components/AlertBanner.vue'
import HostCard from '../components/HostCard.vue'
import AlertPanel from '../components/AlertPanel.vue'
import { sortHostsForOverview } from '../lib/status.js'

const props = defineProps({
  hosts: { type: Array, default: () => [] },
  cluster: { type: Object, default: null },
  alerts: { type: Object, default: () => ({ active: [], resolved: [] }) },
  connected: { type: Boolean, default: false },
})
defineEmits(['open'])

const sorted = computed(() => sortHostsForOverview(props.hosts))
</script>

<template>
  <div class="overview">
    <ClusterBar :cluster="cluster" :connected="connected" />
    <AlertBanner :alerts="alerts.active || []" @open="id => $emit('open', id)" />
    <div class="ov-body">
      <main class="ov-grid">
        <div v-if="!sorted.length" class="ov-empty">
          <p>暂无节点。启动 Agent：python main.py --server ws://&lt;server&gt;:9100 --role &lt;角色&gt;</p>
        </div>
        <HostCard v-for="h in sorted" :key="h.host_id" :host="h"
                  @open="id => $emit('open', id)" />
      </main>
      <AlertPanel class="ov-alerts" :alerts="alerts" @open="id => $emit('open', id)" />
    </div>
  </div>
</template>

<style scoped>
.overview { height: 100%; display: flex; flex-direction: column; overflow: hidden; position: relative; }
.ov-body {
  flex: 1; display: grid; grid-template-columns: 1fr 260px;
  gap: 14px; padding: 14px; overflow: auto;
}
.ov-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px; align-content: start;
}
.ov-empty {
  grid-column: 1 / -1; text-align: center; padding: 60px 20px;
  color: var(--text3); font-size: 13px;
}
.ov-alerts { position: sticky; top: 0; align-self: start; max-height: calc(100vh - 100px); overflow: auto; }
@media (max-width: 900px) {
  .ov-body { grid-template-columns: 1fr; }
}
</style>
