<script setup>
import { computed } from 'vue'
import { hostLevel, LEVEL_RANK, STATUS_TEXT, formatReason } from '../lib/status.js'

const props = defineProps({ hosts: { type: Array, default: () => [] } })
const emit = defineEmits(['open'])

// P1 placeholder: derived directly from instantaneous four-state reasons.
// Full alert lifecycle (debounce/history) arrives with P2.
const alerting = computed(() =>
  props.hosts
    .filter(h => hostLevel(h) !== 'OK')
    .sort((a, b) => LEVEL_RANK[hostLevel(b)] - LEVEL_RANK[hostLevel(a)])
    .map(h => ({
      host: h,
      level: hostLevel(h),
      reason: [...(h.status?.reasons || [])]
        .sort((x, y) => LEVEL_RANK[y.level] - LEVEL_RANK[x.level])[0],
    })),
)
</script>

<template>
  <aside class="alert-panel">
    <div class="ap-title">活动告警 <span class="ap-count">{{ alerting.length }}</span></div>
    <div v-if="!alerting.length" class="ap-empty">✓ 无活动告警</div>
    <div v-else>
      <div class="ap-item" v-for="a in alerting" :key="a.host.host_id"
           :class="a.level.toLowerCase()" @click="emit('open', a.host.host_id)">
        <span class="ap-dot" />
        <div class="ap-body">
          <div class="ap-name">{{ a.host.hostname || a.host.host_id }}
            <em>{{ STATUS_TEXT[a.level] }}</em></div>
          <div class="ap-reason" v-if="a.reason">{{ formatReason(a.reason) }}</div>
        </div>
      </div>
    </div>
    <div class="ap-note">告警防抖与历史由 P2 补全</div>
  </aside>
</template>

<style scoped>
.alert-panel {
  background: var(--bg-glass); border: 1px solid var(--border);
  border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px;
}
.ap-title { font-size: 13px; font-weight: 600; }
.ap-count {
  font-size: 11px; background: rgba(0,0,0,.06); border-radius: 9px;
  padding: 0 7px; margin-left: 4px;
}
.ap-empty { font-size: 12px; color: #1a7f37; padding: 10px 0; }
.ap-item {
  display: flex; gap: 8px; padding: 8px; border-radius: 8px; cursor: pointer;
  border: 1px solid transparent;
}
.ap-item:hover { background: rgba(0,0,0,.03); border-color: var(--border); }
.ap-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 4px; flex-shrink: 0; background: var(--green); }
.ap-item.warn .ap-dot { background: var(--orange); }
.ap-item.crit .ap-dot { background: var(--red); }
.ap-item.offline .ap-dot { background: var(--text3); }
.ap-name { font-size: 12px; font-weight: 600; }
.ap-name em { font-style: normal; font-size: 10px; color: var(--text2); margin-left: 4px; }
.ap-reason { font-size: 11px; color: var(--text2); margin-top: 2px; }
.ap-note { margin-top: auto; font-size: 10px; color: var(--text3); }
</style>
