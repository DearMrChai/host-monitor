<script setup>
import { computed } from 'vue'

/* Generic SVG mini trend chart for server-side history series (P5).
   y-axis starts at 0 (all monitored metrics are >= 0), gaps bridge across nulls. */

const props = defineProps({
  ts: { type: Array, default: () => [] },
  vals: { type: Array, default: () => [] },
  label: { type: String, default: '' },
  unit: { type: String, default: '' },
  warn: { type: Number, default: null },
  crit: { type: Number, default: null },
  color: { type: String, default: 'var(--accent)' },
})

const W = 260, H = 64

const view = computed(() => {
  const pts = []
  for (let i = 0; i < props.ts.length; i++) {
    if (props.vals[i] != null) pts.push([i, props.vals[i]])
  }
  if (!pts.length) return null
  const cands = [Math.max(...pts.map((p) => p[1]))]
  if (props.warn != null) cands.push(props.warn * 1.15)
  if (props.crit != null) cands.push(props.crit * 1.1)
  const max = Math.max(...cands, 1)
  const n = Math.max(props.ts.length - 1, 1)
  const x = (i) => (i / n) * W
  const y = (v) => H - (v / max) * (H - 10) - 5
  return {
    line: pts.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
    last: Math.round(pts[pts.length - 1][1] * 100) / 100,
    warnY: props.warn != null ? y(props.warn).toFixed(1) : null,
    critY: props.crit != null ? y(props.crit).toFixed(1) : null,
    t0: props.ts[0],
    t1: props.ts[props.ts.length - 1],
  }
})

const fmtT = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <div class="trend">
    <div class="trend-top">
      <span class="trend-label">{{ label }}</span>
      <span v-if="view" class="trend-last">{{ view.last }}{{ unit }}</span>
    </div>
    <template v-if="view">
      <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="trend-svg">
        <line v-if="view.warnY" :y1="view.warnY" :y2="view.warnY" x1="0" :x2="W" class="th-warn" />
        <line v-if="view.critY" :y1="view.critY" :y2="view.critY" x1="0" :x2="W" class="th-crit" />
        <!-- stroke via style, not attribute: `color` is a CSS custom property so
             the series colour has one definition like everything else (S4 §1.2),
             and presentation attributes do not resolve var(). -->
        <polyline :points="view.line" :style="{ stroke: color }" class="trend-line" />
      </svg>
      <div class="trend-time">
        <span>{{ fmtT(view.t0) }}</span>
        <span>{{ fmtT(view.t1) }}</span>
      </div>
    </template>
    <div v-else class="trend-none">区间内无数据</div>
  </div>
</template>

<style scoped>
.trend { width: 260px; }
.trend-top { display: flex; justify-content: space-between; font-size: 11px; color: var(--text2); }
.trend-last { font-weight: 600; color: var(--text); }
.trend-svg { width: 100%; height: 64px; background: rgba(0, 0, 0, .03); border-radius: 6px; }
.trend-line { fill: none; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.th-warn { stroke: var(--orange); stroke-dasharray: 3 3; stroke-width: .8; }
.th-crit { stroke: var(--red); stroke-dasharray: 3 3; stroke-width: .8; }
.trend-time { display: flex; justify-content: space-between; font-size: 9px; color: var(--text3); }
.trend-none { font-size: 11px; color: var(--text3); padding: 8px 0; }
</style>
