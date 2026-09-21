<script setup>
import { computed, ref, watch } from 'vue'
import { METRIC_LABELS, unitFor, displayName, isFrozen, FROZEN_TAG } from '../lib/status.js'

/* CRIT/OFFLINE banner (P2). WARN never enters it. Dismissible to a small
   chip; auto re-expands when the critical set changes. */

const props = defineProps({ alerts: { type: Array, default: () => [] } })
const emit = defineEmits(['open'])

const crits = computed(() =>
  props.alerts.filter(a => a.level === 'CRIT' || a.level === 'OFFLINE'))

/* H14: a frozen crit is a claim the Server cannot back up any more, so the one
   thing that must stop is the *urgency signal* - the blinking dot. The row
   stays: retracting an open alert because we lost sight of the machine is the
   other way to lie, and the summary says which is which. */
const allFrozen = computed(() =>
  crits.value.length > 0 && crits.value.every(isFrozen))

const dismissed = ref(false)
watch(() => crits.value.map(a => a.id + a.level).join('|'), (v) => {
  if (v) dismissed.value = false
})

const summary = computed(() => crits.value.slice(0, 2).map(a => {
  const label = METRIC_LABELS[a.metric] || a.metric
  return `${displayName(a)} ${label} ${a.latest_value}${unitFor(a.metric)}`
    + (isFrozen(a) ? `（${FROZEN_TAG}）` : '')
}).join(' · '))

const more = computed(() => Math.max(0, crits.value.length - 2))
</script>

<template>
  <div v-if="crits.length && !dismissed" class="banner" @click="emit('open', crits[0].host_id)">
    <span class="bn-icon" :class="{ still: allFrozen }" />
    <span class="bn-text"><b>{{ crits.length }} 个节点严重/失联</b>{{ summary ? '：' + summary : '' }}<em v-if="more"> 等{{ more }}项</em></span>
    <button class="bn-close" @click.stop="dismissed = true">×</button>
  </div>
  <div v-else-if="crits.length" class="banner-chip" @click="dismissed = false">
    🔔 {{ crits.length }} 严重告警（已收起）
  </div>
</template>

<style scoped>
.banner {
  display: flex; align-items: center; gap: 10px;
  margin: 10px 14px 0; padding: 10px 14px; cursor: pointer;
  background: color-mix(in srgb, var(--red) 10%, transparent); border: 1px solid color-mix(in srgb, var(--red) 50%, transparent);
  border-radius: 8px; color: var(--red);
}
.bn-icon { width: 10px; height: 10px; border-radius: 50%; background: var(--red); animation: blink 1s infinite; flex-shrink: 0; }
.bn-icon.still { animation: none; opacity: .55; }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }
.bn-text { font-size: 13px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bn-text em { font-style: normal; color: var(--text2); }
.bn-close {
  border: none; background: none; color: inherit; font-size: 16px;
  cursor: pointer; padding: 0 4px;
}
.banner-chip {
  position: absolute; top: 12px; right: 14px; z-index: 30;
  font-size: 12px; padding: 4px 10px; cursor: pointer;
  background: var(--bg-glass); border: 1px solid var(--red); color: var(--red);
  border-radius: 12px;
}
</style>
