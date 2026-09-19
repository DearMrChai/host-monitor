<script setup>
import { computed } from 'vue'
import { coords } from '../lib/series.js'

/* A 2h memory of the card's primary metric (S3b §6.2-§6.3).
   Deliberately tiny and deliberately not a second chart: it answers "is this
   machine busy right now, or has it been busy all afternoon", which the live bar
   cannot. No axes, no tooltip - a 3-metre-away glance gets nothing from those. */

const props = defineProps({
  points: { type: Array, default: () => [] },
  label: { type: String, default: '' },
  delta: { type: Object, default: null },
  width: { type: Number, default: 100 },
  height: { type: Number, default: 24 },
})

const W = 100
const H = 24

/* Gaps (a bucket with no sample) must break the line rather than be drawn
   across - a straight jump over an outage is exactly the lie this panel is
   meant to stop telling. */
const segments = computed(() => {
  const pts = coords(props.points, W, H)
  const out = []
  let cur = []
  for (const p of pts) {
    if (p) cur.push(p)
    else if (cur.length) { out.push(cur); cur = [] }
  }
  if (cur.length) out.push(cur)
  return out.filter((s) => s.length > 1)
})

const tip = computed(() => {
  const vals = props.points.filter((v) => v != null)
  if (!vals.length) return ''
  const now = vals[vals.length - 1]
  return `${props.label} 近 2 小时：当前 ${Math.round(now)}% · `
    + `最低 ${Math.round(Math.min(...vals))}% · 最高 ${Math.round(Math.max(...vals))}%`
})

const hasData = computed(() => segments.value.length > 0)
</script>

<template>
  <span class="spark" :class="delta ? delta.dir : 'flat'" :title="tip">
    <span class="sp-label" v-if="label">{{ label }}</span>
    <svg v-if="hasData" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none"
         class="sp-svg" aria-hidden="true">
      <polyline v-for="(s, i) in segments" :key="i" :points="s.map(p => p.join(',')).join(' ')"
                fill="none" stroke="currentColor" stroke-width="1.4"
                stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    </svg>
    <span v-else class="sp-none">—</span>
    <em class="sp-delta" v-if="delta && delta.pct">
      {{ delta.dir === 'up' ? '↑' : delta.dir === 'down' ? '↓' : '→' }}{{ Math.abs(delta.pct) }}%
    </em>
  </span>
</template>

<style scoped>
.spark {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 10px; color: var(--text3);
}
.sp-label { color: var(--text3); letter-spacing: .2px; }
.sp-svg { width: 62px; height: 18px; color: var(--text3); overflow: visible; }
.sp-none { width: 62px; display: inline-block; text-align: center; }
.sp-delta { font-style: normal; font-variant-numeric: tabular-nums; }

/* Direction colours are NOT the four-state palette (S3 §6.3). A rising load is
   not a warning, and borrowing --orange/--red for it would teach the eye that
   the top-right corner of a card is an alarm. */
.spark.up .sp-svg, .spark.up .sp-delta { color: var(--up); }
.spark.down .sp-svg, .spark.down .sp-delta { color: var(--down); }
.spark.flat .sp-svg { color: var(--text3); }
.spark.flat .sp-delta { color: var(--text3); }
</style>
