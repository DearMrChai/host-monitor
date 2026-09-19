<script setup>
import { computed, ref, onUnmounted } from 'vue'
import { LEVEL_RANK, STATUS_TEXT, formatReason, displayName, resolvedText } from '../lib/status.js'

/* P2: driven by the debounced alert engine (active + resolved window),
   no longer by instantaneous reasons. */

const props = defineProps({
  alerts: { type: Object, default: () => ({ active: [], resolved: [] }) },
})
const emit = defineEmits(['open'])

const now = ref(Date.now())
const timer = setInterval(() => { now.value = Date.now() }, 1000)
onUnmounted(() => clearInterval(timer))

const active = computed(() => props.alerts.active || [])
const resolved = computed(() => props.alerts.resolved || [])

function duration(a) {
  if (!a.started_at) return ''
  const end = a.resolved_at || now.value
  const s = Math.max(0, Math.floor((end - a.started_at) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? (s % 60) + 's' : ''}`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

function metricText(a) {
  return formatReason({ ...a, value: a.latest_value })
}
</script>

<template>
  <aside class="alert-panel">
    <div class="ap-title">活动告警 <span class="ap-count">{{ active.length }}</span></div>
    <div v-if="!active.length" class="ap-empty">✓ 无活动告警</div>
    <div v-else>
      <div class="ap-item" v-for="a in active" :key="a.id"
           :class="a.level.toLowerCase()" @click="emit('open', a.host_id)">
        <span class="ap-dot" />
        <div class="ap-body">
          <div class="ap-name">{{ displayName(a) }}
            <em>{{ STATUS_TEXT[a.level] }}</em>
            <span class="ap-dur">{{ duration(a) }}</span>
          </div>
          <div class="ap-reason">{{ metricText(a) }}</div>
        </div>
      </div>
    </div>

    <details v-if="resolved.length" class="ap-resolved">
      <summary>最近恢复 / 关闭 ({{ resolved.length }})</summary>
      <div class="ap-item done" v-for="a in resolved" :key="a.id"
           :class="a.level.toLowerCase()">
        <span class="ap-dot" />
        <div class="ap-body">
          <div class="ap-name">{{ displayName(a) }} <em>{{ resolvedText(a) }} · {{ duration(a) }}</em></div>
          <div class="ap-reason">{{ metricText(a) }}</div>
        </div>
      </div>
    </details>
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
.ap-empty { font-size: 12px; color: var(--ok-ink); padding: 10px 0; }
.ap-item {
  display: flex; gap: 8px; padding: 8px; border-radius: 8px; cursor: pointer;
  border: 1px solid transparent;
}
.ap-item:hover { background: rgba(0,0,0,.03); border-color: var(--border); }
.ap-item.done { cursor: default; opacity: .7; }
.ap-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 4px; flex-shrink: 0; background: var(--green); }
.ap-item.warn .ap-dot { background: var(--orange); }
.ap-item.crit .ap-dot { background: var(--red); }
.ap-item.offline .ap-dot { background: var(--text3); }
.ap-name { font-size: 12px; font-weight: 600; display: flex; align-items: baseline; gap: 4px; }
.ap-name em { font-style: normal; font-size: 10px; color: var(--text2); font-weight: 400; }
.ap-dur { margin-left: auto; font-size: 10px; color: var(--text3); font-weight: 400; }
.ap-reason { font-size: 11px; color: var(--text2); margin-top: 2px; }
.ap-resolved { border-top: 1px dashed var(--border); padding-top: 6px; }
.ap-resolved summary { font-size: 11px; color: var(--text3); cursor: pointer; }
</style>
