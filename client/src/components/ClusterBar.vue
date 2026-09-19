<script setup>
import { computed } from 'vue'
import { STATUS_TEXT } from '../lib/status.js'
import { sound, toggleMute, unlock } from '../lib/sound.js'
import { admin, openDialog } from '../lib/admin.js'

const props = defineProps({
  cluster: { type: Object, default: null },
  connected: { type: Boolean, default: false },
  view: { type: String, default: 'overview' },
  pendingCount: { type: Number, default: 0 },
})
defineEmits(['toggle', 'goto-pending'])

function onBell() {
  unlock()
  if (!sound.unlocked) return
  toggleMute()
}

const health = computed(() => props.cluster?.health || 'OFFLINE')
const healthClass = computed(() => health.value.toLowerCase())

/* S1b: the denominator is now persistent nodes only. total===0 means "no node
   is trusted to be here" — reporting 正常 for that would be a lie, and it is
   also the state you reach by retiring everything by accident. */
const empty = computed(() => !!props.cluster && props.cluster.total === 0)
const onlineText = computed(() =>
  (!props.cluster || empty.value ? '—' : `${props.cluster.online}/${props.cluster.total}`))
const presence = computed(() => props.cluster?.presence || null)

function onKey() {
  openDialog(admin.passphraseSet ? '更换管理口令' : '设置管理口令后才能操作节点')
}

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
      <span class="health-pill" :class="empty ? 'offline' : healthClass">
        <i class="hp-dot" /> {{ empty ? '无常驻节点' : '集群' + STATUS_TEXT[health] }}
      </span>
      <span class="cb-online" v-if="cluster"
            :title="empty ? '所有节点都被归为临时/退役，健康度与在线率没有可统计的常驻机' : '仅统计常驻节点'">
        在线 <b>{{ onlineText }}</b>
      </span>
      <span class="cb-presence" v-if="presence && presence.online"
            :title="`临时节点在场 ${presence.online}/${presence.total}：不报警、不计入在线率`">
        · 在场 {{ presence.online }}
      </span>
      <!-- Silence must be visible at the top line too, or a muted fleet just
           looks healthy (S1 §3.3 honesty limit). -->
      <span class="cb-muted" v-if="cluster?.muted_count"
            :title="cluster.muted_count + ' 个节点的阈值告警处于静默中（失联不受静默影响）'">
        🔕 {{ cluster.muted_count }}
      </span>
      <span class="pending-badge" v-if="pendingCount" @click="$emit('goto-pending')"
            :title="'名册里有 ' + pendingCount + ' 个节点还没确认归类'">
        待确认 {{ pendingCount }}
      </span>
      <span class="link-degraded" :class="cluster?.link?.worst_level?.toLowerCase()"
            v-if="cluster?.link?.worst_level"
            title="链路异常节点数（详见拓扑视图）">
        链路异常 {{ cluster.link.degraded_count }}
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
    <div class="cb-view">
      <button :class="{ active: view === 'overview' }" @click="$emit('toggle', 'overview')">总览</button>
      <button :class="{ active: view === 'topology' }" @click="$emit('toggle', 'topology')">拓扑</button>
    </div>
    <div class="cb-sound">
      <span v-if="!sound.unlocked" class="unlock-hint" @click="onBell">点击激活声音</span>
      <button class="bell" :class="{ muted: sound.muted }" :title="sound.muted ? '取消静音' : '静音'"
              @click="onBell">{{ sound.muted ? '🔇' : '🔊' }}</button>
      <button class="key" :class="{ unset: !admin.passphraseSet }"
              :title="admin.passphraseSet ? '管理口令：更换' : '设置管理口令（否则无法操作节点）'"
              @click="onKey">🔑</button>
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
.cb-presence { font-size: 11px; color: var(--text3); }
.cb-muted { font-size: 11px; color: #9a6700; }
.pending-badge {
  font-size: 11px; padding: 2px 9px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--accent); color: var(--accent); background: rgba(9,105,218,.08);
}
.link-degraded {
  font-size: 11px; padding: 2px 9px; border-radius: 10px;
  border: 1px solid var(--orange); color: #9a6700; background: rgba(210,153,34,.10);
}
.link-degraded.crit { border-color: var(--red); color: #b62324; background: rgba(248,81,73,.10); }
.cb-view { display: flex; gap: 0; border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
.cb-view button {
  font: inherit; font-size: 12px; border: none; cursor: pointer;
  padding: 4px 14px; background: var(--bg-glass); color: var(--text2);
}
.cb-view button.active { background: var(--accent); color: #fff; }
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
.key {
  border: 1px solid var(--border); background: var(--bg-glass);
  border-radius: 14px; font-size: 13px; padding: 3px 9px; cursor: pointer;
}
/* No passphrase yet = no write actions available anywhere, so say so. */
.key.unset { border-color: var(--orange); border-style: dashed; }
</style>
