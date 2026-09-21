<script setup>
import { computed } from 'vue'
import EventStream from './EventStream.vue'
import {
  ROLE_LABELS, formatUptime, formatReason, resolvedText,
  displayName, isAbsent, formatSeenLast, formatAgo, CLASS_LABELS, CLASS_HINT,
  absenceCause,
} from '../lib/status.js'
import { stream } from '../lib/events.js'

/* V2 right column: 2D numeric HUD panel (P4 two-layer rework).
   Rows are clickable -> parent opens the matching V3 drawer.
   Levels/colors come from server-derived status, never re-thresholded here. */

const props = defineProps({
  host: { type: Object, required: true },
  alerts: { type: Object, default: () => ({ active: [], resolved: [] }) },
})
const emit = defineEmits(['drawer'])

/* Shared with the overview rail (lib/events.js), so no second poller starts here. */
const myEvents = computed(() => stream.events.filter((e) => e.host_id === props.host.host_id))

const m = computed(() => props.host.metrics || {})
const comp = computed(() => props.host.status?.components || {})
const absent = computed(() => isAbsent(props.host))
const nodeClass = computed(() => props.host.presence_class || 'persistent')
const mutedUntil = computed(() => Number(props.host.muted_until) || null)

function cls(level) {
  return level ? level.toLowerCase() : 'none'
}

const cpuRow = computed(() => {
  const c = m.value.cpu
  if (!c) return null
  const parts = []
  if (c.usage_percent != null) parts.push(c.usage_percent.toFixed(0) + '%')
  if (c.temperature_c != null) parts.push(c.temperature_c + '°C')
  if (c.freq_mhz) parts.push((c.freq_mhz / 1000).toFixed(1) + 'GHz')
  return { text: parts.join(' · ') || '—', level: comp.value.cpu?.level }
})

const gpuRows = computed(() => (m.value.gpu || []).map((g, i) => {
  const key = `gpu${g.index ?? i}`
  const parts = []
  if (g.usage_percent != null) parts.push(g.usage_percent + '%')
  if (g.temperature_c != null) parts.push(g.temperature_c + '°C')
  if (g.vram_used_mb != null && g.vram_total_mb)
    parts.push(`${(g.vram_used_mb / 1024).toFixed(1)}/${(g.vram_total_mb / 1024).toFixed(0)}G`)
  return {
    key, label: g.name ? `GPU${g.index ?? i} ${String(g.name).slice(0, 12)}` : `GPU${g.index ?? i}`,
    text: parts.join(' · ') || '—',
    level: comp.value.gpu?.find(x => x.id === key)?.level,
    index: g.index ?? i,
  }
}))

const memRow = computed(() => {
  const r = m.value.memory
  if (!r) return null
  return {
    text: `${r.percent}% · ${r.used_gb?.toFixed(1)}/${r.total_gb}G`,
    level: comp.value.mem?.level,
  }
})

const diskRow = computed(() => {
  const d = m.value.disk
  if (!d?.partitions?.length) return null
  const worst = d.partitions.reduce((a, b) => (b.percent > a.percent ? b : a))
  let text = `${d.worst_percent}% 最满 ${worst.mountpoint}`
  if (d.io && d.io.read_mb_s != null) text += ` · R${d.io.read_mb_s} W${d.io.write_mb_s}MB/s`
  return { text, level: comp.value.disk?.level }
})

const netRow = computed(() => {
  const n = m.value.network
  if (!n) return null
  return { text: `↓${n.download_mbps} ↑${n.upload_mbps} Mbps`, level: null }
})

const linkRows = computed(() => (comp.value.link?.targets || []).map(t => ({
  key: t.target,
  label: `↔${t.name}`,
  kind: t.kind,
  text: `${t.rtt_ms != null ? '↘' + t.rtt_ms + 'ms' : '无数据'} · 丢${t.loss_pct ?? '—'}%`,
  level: t.level,
})))

const myAlerts = computed(() => {
  const id = props.host.host_id
  return {
    active: (props.alerts.active || []).filter(a => a.host_id === id),
    resolved: (props.alerts.resolved || []).filter(a => a.host_id === id),
  }
})

const uptimeText = computed(() => {
  const s = m.value.system?.uptime_seconds
  return s != null ? formatUptime(s) : null
})
</script>

<template>
  <aside class="hud-panel">
    <div class="hud-head">
      <span :title="'host_id: ' + host.host_id">{{ displayName(host) }}</span>
      <em class="hud-role">{{ ROLE_LABELS[host.role] || host.role }}</em>
      <em class="hud-class" :class="nodeClass" :title="CLASS_HINT[nodeClass]">{{ CLASS_LABELS[nodeClass] }}</em>
      <em class="hud-muted" v-if="mutedUntil" :title="'静默至 ' + formatSeenLast(mutedUntil)">🔕</em>
      <span class="hud-up" v-if="uptimeText">开机 {{ uptimeText }}</span>
    </div>

    <template v-if="host.online">
      <div class="hud-sec-title">组件</div>
      <div class="hud-row" v-if="cpuRow" @click="emit('drawer', { kind: 'cpu' })">
        <i class="dot" :class="cls(cpuRow.level)" /><span class="hr-label">CPU</span>
        <span class="hr-val">{{ cpuRow.text }}</span>
      </div>
      <div class="hud-row" v-for="g in gpuRows" :key="g.key"
           @click="emit('drawer', { kind: 'gpu', key: g.key, index: g.index })">
        <i class="dot" :class="cls(g.level)" /><span class="hr-label">{{ g.label }}</span>
        <span class="hr-val">{{ g.text }}</span>
      </div>
      <div class="hud-row" v-if="memRow" @click="emit('drawer', { kind: 'mem' })">
        <i class="dot" :class="cls(memRow.level)" /><span class="hr-label">内存</span>
        <span class="hr-val">{{ memRow.text }}</span>
      </div>
      <div class="hud-row" v-if="diskRow" @click="emit('drawer', { kind: 'disk' })">
        <i class="dot" :class="cls(diskRow.level)" /><span class="hr-label">磁盘</span>
        <span class="hr-val">{{ diskRow.text }}</span>
      </div>
      <div class="hud-row" v-if="netRow" @click="emit('drawer', { kind: 'network' })">
        <i class="dot none" /><span class="hr-label">网络</span>
        <span class="hr-val">{{ netRow.text }}</span>
      </div>

      <template v-if="linkRows.length">
        <div class="hud-sec-title">链路</div>
        <div class="hud-row" v-for="l in linkRows" :key="l.key"
             @click="emit('drawer', { kind: 'link', target: l.key, name: l.label.slice(1) })">
          <i class="dot" :class="cls(l.level)" /><span class="hr-label">{{ l.label }}<em class="hr-kind">{{ l.kind }}</em></span>
          <span class="hr-val">{{ l.text }}</span>
        </div>
      </template>

      <template v-if="(myAlerts.active.length || myAlerts.resolved.length) && !myEvents.length">
        <!-- The stream already carries this machine's crossings (they come from
             the same alert_events rows, S3 §2), so showing both would print the
             same fact twice in two different fonts. This block is the fallback
             for a history-disabled Server, where the stream is empty by design. -->
        <div class="hud-sec-title">本机告警</div>
        <div class="hud-alert" v-for="a in myAlerts.active" :key="a.id" :class="cls(a.level)">
          <i class="dot" :class="cls(a.level)" />
          <span>{{ a.level === 'OFFLINE' ? '失联' : '' }}{{ formatReason({ ...a, value: a.latest_value }) }}</span>
        </div>
        <div class="hud-alert done" v-for="a in myAlerts.resolved" :key="a.id">
          <i class="dot" :class="a.cancelled ? 'none' : 'ok'" /><span>{{ resolvedText(a) }} {{ formatReason({ ...a, value: a.latest_value }) }}</span>
        </div>
      </template>
    </template>

    <div v-else-if="absent" class="hud-absent">
      {{ host.absent_record ? `该常驻节点${absenceCause(host)}` : '该临时节点已离场' }}
      · 上次在场 {{ formatSeenLast(host.last_seen) }}（{{ formatAgo(host.last_seen) }}）
      <em>{{ host.absent_record
        ? '计入在线率与事件流，不计入集群健康度'
        : '不报警、不计入在线率' }}</em>
    </div>
    <div v-else class="hud-offline">
      节点失联{{ host.lastSeen ? ' · 最后上报 ' + new Date(host.lastSeen).toLocaleTimeString() : '' }}
    </div>

    <!-- S3b §6.1: "what happened to this machine today", in the one place a
         person looks when a card has caught their eye. -->
    <EventStream class="hud-events" :host-id="host.host_id" compact :max-rows="12"
                 title="本机事件" />
  </aside>
</template>

<style scoped>
.hud-panel {
  width: 300px; flex-shrink: 0; overflow-y: auto;
  background: var(--bg-glass); border-left: 1px solid var(--border);
  padding: 10px 12px; display: flex; flex-direction: column; gap: 4px;
}
.hud-head { font-size: 13px; font-weight: 600; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.hud-role { font-style: normal; font-size: 10px; color: var(--text2); border: 1px solid var(--border); border-radius: 8px; padding: 0 6px; }
.hud-up { margin-left: auto; font-size: 10px; color: var(--text3); font-weight: 400; }
.hud-sec-title { font-size: 11px; color: var(--text3); margin-top: 10px; border-bottom: 1px dashed var(--border); padding-bottom: 2px; }
.hud-row {
  display: flex; align-items: center; gap: 8px; font-size: 12px;
  padding: 6px 4px; border-radius: 6px; cursor: pointer;
}
.hud-row:hover { background: rgba(0, 0, 0, .04); }
.hr-label { min-width: 64px; font-weight: 500; display: flex; align-items: baseline; gap: 4px; }
.hr-kind { font-style: normal; font-size: 9px; color: var(--text3); border: 1px solid var(--border); border-radius: 6px; padding: 0 4px; }
.hr-val { margin-left: auto; text-align: right; color: var(--text2); font-variant-numeric: tabular-nums; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--text3); }
.dot.ok { background: var(--green); }
.dot.warn { background: var(--orange); }
.dot.crit { background: var(--red); }
.dot.none { background: transparent; border: 1px solid var(--border); }
.hud-alert { display: flex; gap: 6px; align-items: baseline; font-size: 11px; color: var(--text2); padding: 3px 4px; }
.hud-alert.crit { color: var(--crit-ink); }
.hud-alert.warn { color: var(--warn-ink); }
.hud-alert.done { opacity: .65; }
.hud-offline { font-size: 12px; color: var(--text2); padding: 16px 0; }
.hud-absent { font-size: 12px; color: var(--text2); padding: 16px 0; line-height: 1.6; }
.hud-absent em { display: block; font-style: normal; font-size: 11px; color: var(--text3); }
.hud-class {
  font-style: normal; font-size: 10px; border-radius: 8px; padding: 0 6px;
  color: var(--ok-ink); background: color-mix(in srgb, var(--green) 10%, transparent);
}
.hud-class.ephemeral { color: var(--text2); background: rgba(0,0,0,.05); border: 1px dashed var(--border); }
.hud-muted { font-style: normal; font-size: 11px; }
/* Flat inside the HUD: it is already one glass panel, and a second frame inside
   it reads as a widget that does not belong to this machine. Two classes for
   specificity - a single one can lose to the child's own .event-stream rule. */
.hud-panel .hud-events {
  border: none; border-top: 1px dashed var(--border);
  border-radius: 0; background: none; padding: 8px 0 2px;
}
</style>
