<script setup>
import { computed } from 'vue'
import { STATUS_TEXT } from '../lib/status.js'
import { sound, toggleMute, unlock } from '../lib/sound.js'

const props = defineProps({
  cluster: { type: Object, default: null },
  connected: { type: Boolean, default: false },
})

function onBell() {
  unlock()
  if (!sound.unlocked) return
  toggleMute()
}

const health = computed(() => props.cluster?.health || 'OFFLINE')
const healthClass = computed(() => health.value.toLowerCase())

const bars = computed(() => {
  const agg = props.cluster?.aggregate
  if (!agg) return []
  return [
    { key: 'CPU', data: agg.cpu },
    { key: '内存', data: agg.mem },
    { key: 'GPU', data: agg.gpu },
  ]
})
</script>

<template>
  <header class="cluster-bar">
    <div class="cb-left">
      <span class="conn-dot" :class="{ ok: connected }" />
      <span class="cb-title">Host Monitor</span>
      <span class="health-pill" :class="healthClass">
        <i class="hp-dot" /> 集群{{ STATUS_TEXT[health] }}
      </span>
      <span class="cb-online" v-if="cluster">
        在线 <b>{{ cluster.online }}</b>/{{ cluster.total }}
      </span>
    </div>
    <div class="cb-agg" v-if="cluster">
      <span class="agg" v-for="b in bars" :key="b.key">
        <span class="agg-label">{{ b.key }}</span>
        <span class="agg-bar">
          <i class="agg-peak" v-if="b.data.peak != null" :style="{ left: b.data.peak + '%' }" />
          <i class="agg-fill" :style="{ width: (b.data.avg ?? 0) + '%' }" />
        </span>
        <span class="agg-val" v-if="b.data.avg != null">
          {{ b.data.avg }}%<em v-if="b.data.peak != null && b.data.peak !== b.data.avg">
            /峰{{ b.data.peak }}</em>
        </span>
        <span class="agg-val na" v-else>—</span>
      </span>
    </div>
    <div class="cb-sound">
      <span v-if="!sound.unlocked" class="unlock-hint" @click="onBell">点击激活声音</span>
      <button class="bell" :class="{ muted: sound.muted }" :title="sound.muted ? '取消静音' : '静音'"
              @click="onBell">{{ sound.muted ? '🔇' : '🔊' }}</button>
    </div>
  </header>
</template>

<style scoped>
.cluster-bar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; padding: 10px 16px;
  background: var(--bg-glass); border-bottom: 1px solid var(--border);
}
.cb-left { display: flex; align-items: center; gap: 10px; }
.cb-title { font-size: 14px; font-weight: 600; }
.conn-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--red); }
.conn-dot.ok { background: var(--green); animation: pulse 2s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

.health-pill {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 13px; font-weight: 700; padding: 4px 12px;
  border-radius: 14px; border: 1px solid;
}
.health-pill .hp-dot { width: 9px; height: 9px; border-radius: 50%; }
.health-pill.ok   { color: #1a7f37; border-color: rgba(30,140,50,.4);  background: rgba(30,140,50,.08); }
.health-pill.ok .hp-dot   { background: var(--green); }
.health-pill.warn { color: #9a6700; border-color: rgba(210,153,34,.5); background: rgba(210,153,34,.10); }
.health-pill.warn .hp-dot { background: var(--orange); }
.health-pill.crit { color: #b62324; border-color: rgba(248,81,73,.5);  background: rgba(248,81,73,.10); }
.health-pill.crit .hp-dot { background: var(--red); animation: pulse 1s infinite; }
.health-pill.offline { color: var(--text2); border-color: var(--border); background: rgba(0,0,0,.04); }
.health-pill.offline .hp-dot { background: var(--text3); }

.cb-online { font-size: 12px; color: var(--text2); }
.cb-agg { display: flex; gap: 18px; }
.agg { display: flex; align-items: center; gap: 6px; }
.agg-label { font-size: 11px; color: var(--text2); }
.agg-bar {
  position: relative; width: 90px; height: 6px;
  background: rgba(0,0,0,.07); border-radius: 3px; overflow: hidden;
}
.agg-fill { position: absolute; inset: 0 auto 0 0; background: var(--green); border-radius: 3px; transition: width .6s; }
.agg-peak { position: absolute; top: 0; bottom: 0; width: 2px; background: rgba(0,0,0,.35); }
.agg-val { font-size: 11px; min-width: 62px; }
.agg-val.na { color: var(--text3); }
.agg-val em { font-style: normal; color: var(--text3); }
.cb-sound { display: flex; align-items: center; gap: 8px; }
.unlock-hint { font-size: 11px; color: var(--accent); cursor: pointer; }
.bell {
  border: 1px solid var(--border); background: var(--bg-glass);
  border-radius: 14px; font-size: 13px; padding: 3px 9px; cursor: pointer;
}
.bell.muted { opacity: .55; }
</style>
