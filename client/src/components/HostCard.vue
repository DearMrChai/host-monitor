<script setup>
import { computed } from 'vue'
import { hostLevel, LEVEL_RANK, ROLE_LABELS, STATUS_TEXT, formatUptime, formatReason } from '../lib/status.js'

const props = defineProps({ host: { type: Object, required: true } })
defineEmits(['open'])

const level = computed(() => hostLevel(props.host))
const m = computed(() => props.host.metrics)
const comp = computed(() => props.host.status?.components || {})

const bars = computed(() => {
  const out = []
  const mm = m.value
  if (!mm) return out
  out.push({ key: 'CPU', value: mm.cpu?.usage_percent, level: comp.value.cpu?.level })
  out.push({ key: '内存', value: mm.memory?.percent, level: comp.value.mem?.level })
  const gpus = mm.gpu || []
  if (gpus.length) {
    const usage = gpus.map(g => g.usage_percent).filter(v => v != null)
    const gpuLevels = (comp.value.gpu || []).map(g => g.level)
    out.push({
      key: 'GPU',
      value: usage.length ? Math.max(...usage) : null,
      level: gpuLevels.reduce((a, l) =>
        (l && (!a || LEVEL_RANK[l] > LEVEL_RANK[a]) ? l : a), null),
    })
  }
  out.push({
    key: '磁盘',
    value: comp.value.disk?.worst_percent ?? null,
    level: comp.value.disk?.level,
  })
  return out
})

const reasons = computed(() => {
  const rs = props.host.status?.reasons || []
  return [...rs]
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level])
    .slice(0, 2)
})

const linkLevel = computed(() => comp.value.link?.level || null)
const linkTargets = computed(() => comp.value.link?.targets || [])
const serverRtt = computed(() =>
  linkTargets.value.find(t => t.target === 'server')?.rtt_ms ?? null)
const linkTip = computed(() => linkTargets.value.length
  ? linkTargets.value.map(t =>
      `${t.name} ${t.rtt_ms != null ? t.rtt_ms + 'ms' : '—'} 丢${t.loss_pct}%`).join(' · ')
  : '暂无链路探测数据')
const linkText = computed(() => {
  if (!linkLevel.value) return '—'
  return serverRtt.value != null ? `↘${serverRtt.value}ms` : STATUS_TEXT[linkLevel.value]
})
const uptime = computed(() => formatUptime(m.value?.system?.uptime_seconds))
const pending = computed(() => props.host.status?.pending || [])
</script>

<template>
  <div class="host-card" :class="'lv-' + level.toLowerCase()" @click="$emit('open', host.host_id)">
    <div class="hc-head">
      <span class="hc-name">{{ host.hostname || host.host_id }}</span>
      <span class="hc-pending" v-if="pending.length"
            :title="'观察中: ' + pending.map(p => p.metric).join(', ')">观察中</span>
      <span class="hc-role">{{ ROLE_LABELS[host.role] || host.role || '其他' }}</span>
    </div>

    <div class="hc-link" :title="linkTip">
      链路 <i class="lk-dot" :class="linkLevel ? linkLevel.toLowerCase() : 'na'" />
      <b :class="linkLevel ? linkLevel.toLowerCase() : 'na'">{{ linkText }}</b>
      <span class="hc-uptime" v-if="uptime">开机 {{ uptime }}</span>
    </div>

    <div class="hc-bars" v-if="m">
      <div class="hcb" v-for="b in bars" :key="b.key">
        <span class="hcb-label">{{ b.key }}</span>
        <span class="hcb-bar">
          <i class="hcb-fill" :class="b.level ? b.level.toLowerCase() : ''"
             :style="{ width: (b.value ?? 0) + '%' }" />
        </span>
        <span class="hcb-val" v-if="b.value != null">{{ Math.round(b.value) }}%</span>
        <span class="hcb-val na" v-else>—</span>
      </div>
    </div>
    <div class="hc-nodata" v-else>等待首帧数据…</div>

    <div class="hc-reasons" v-if="reasons.length">
      <div class="hcr" v-for="(r, i) in reasons" :key="i" :class="r.level.toLowerCase()">
        {{ formatReason(r) }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.host-card {
  background: var(--bg-glass); border: 2px solid var(--border);
  border-radius: 10px; padding: 12px 14px; cursor: pointer;
  transition: box-shadow .2s, border-color .2s;
  display: flex; flex-direction: column; gap: 8px;
}
.host-card:hover { box-shadow: 0 2px 10px rgba(0,0,0,.08); }
.host-card.lv-warn    { border-color: var(--orange); }
.host-card.lv-crit    { border-color: var(--red); }
.host-card.lv-offline { border-color: var(--text3); opacity: .75; }

.hc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hc-name { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hc-role {
  font-size: 10px; color: var(--text2); padding: 1px 8px; flex-shrink: 0;
  border: 1px solid var(--border); border-radius: 9px; background: rgba(0,0,0,.03);
}
.hc-pending {
  font-size: 10px; color: #9a6700; flex-shrink: 0; margin-left: auto;
  background: rgba(210,153,34,.12); border-radius: 9px; padding: 1px 7px;
}

.hc-link { font-size: 11px; color: var(--text3); display: flex; align-items: center; gap: 6px; }
.hc-link b { font-weight: 600; }
.lk-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
.lk-dot.na { background: var(--text3); }
.lk-dot.warn { background: var(--orange); }
.lk-dot.crit { background: var(--red); }
.lk-dot.offline { background: var(--text3); }
.hc-link b.ok { color: var(--green); }
.hc-link b.na { color: var(--text3); }
.hc-link b.warn { color: var(--orange); }
.hc-link b.crit { color: var(--red); }
.hc-link b.offline { color: var(--text3); }
.hc-uptime { margin-left: auto; font-size: 10px; }

.hcb { display: flex; align-items: center; gap: 8px; }
.hcb-label { font-size: 11px; color: var(--text2); min-width: 30px; }
.hcb-bar { flex: 1; height: 5px; background: rgba(0,0,0,.07); border-radius: 3px; overflow: hidden; }
.hcb-fill { display: block; height: 100%; border-radius: 3px; background: var(--green); transition: width .6s; }
.hcb-fill.warn { background: var(--orange); }
.hcb-fill.crit { background: var(--red); }
.hcb-val { font-size: 11px; min-width: 34px; text-align: right; }
.hcb-val.na { color: var(--text3); }

.hc-nodata { font-size: 12px; color: var(--text3); padding: 8px 0; }
.hc-reasons { border-top: 1px dashed var(--border); padding-top: 6px; display: flex; flex-direction: column; gap: 2px; }
.hcr { font-size: 10px; color: var(--text2); }
.hcr.warn { color: #9a6700; }
.hcr.crit { color: #b62324; }
</style>
