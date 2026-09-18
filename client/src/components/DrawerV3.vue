<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import TrendChart from './TrendChart.vue'
import { STATUS_TEXT, ROLE_LABELS, formatUptime } from '../lib/status.js'

/* V3 drawer: bottom slide-out with per-component / per-link detail (P4),
   P5: server-side history trend charts (GET /api/history) + persisted
   alert log in the system view. */

const props = defineProps({
  host: { type: Object, required: true },
  spec: { type: Object, required: true },   // {kind, index?, target?, name?}
  thresholds: { type: Object, default: () => ({}) },
})
defineEmits(['close'])

const m = computed(() => props.host.metrics || {})

const title = computed(() => {
  const s = props.spec
  return {
    cpu: 'CPU 分核明细', mem: '内存池明细', disk: '磁盘明细',
    network: '网络明细', system: '系统信息',
    gpu: `GPU${s.index} 明细`, link: `链路 ↔${s.name} 明细`,
  }[s.kind] || '明细'
})

function coreClass(p) {
  const th = props.thresholds.cpu_usage || { warn: 80, crit: 95 }
  return p > th.crit ? 'crit' : p > th.warn ? 'warn' : ''
}

const gpu = computed(() => {
  if (props.spec.kind !== 'gpu') return null
  return (m.value.gpu || [])[props.spec.index] || null
})

const linkTarget = computed(() => {
  if (props.spec.kind !== 'link') return null
  return (props.host.status?.components?.link?.targets || [])
    .find(t => t.target === props.spec.target) || null
})

const rows = (obj) => Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)

/* ---------- P5: server history ---------- */

const RANGE_OPTIONS = ['2h', '24h', '7d', '30d']
const TREND_KINDS = ['cpu', 'gpu', 'mem', 'disk', 'link']

const range = ref('2h')
const history = ref(null)
const alertLog = ref([])
let timer = null

async function reload() {
  const { kind } = props.spec
  if (kind === 'system') {
    try {
      const res = await fetch('/api/alerts/history?limit=100')
      const data = await res.json()
      alertLog.value = (data.alerts || []).filter(a => a.host_id === props.host.host_id)
    } catch { alertLog.value = [] }
    return
  }
  if (!TREND_KINDS.includes(kind)) { history.value = null; return }
  try {
    const res = await fetch(
      `/api/history/${encodeURIComponent(props.host.host_id)}?range=${range.value}`)
    history.value = await res.json()
  } catch { history.value = null }
}

watch(
  () => [props.spec.kind, props.spec.index, props.spec.target, range.value, props.host.host_id],
  () => {
    reload()
    clearInterval(timer)
    timer = setInterval(reload, 60_000)
  },
  { immediate: true },
)
onBeforeUnmount(() => clearInterval(timer))

const trendSeries = computed(() => {
  const h = history.value
  const s = props.spec
  if (!h || !TREND_KINDS.includes(s.kind)) return []
  const th = props.thresholds
  switch (s.kind) {
    case 'cpu':
      return [
        { label: 'CPU 占用', unit: '%', vals: h.cpu.usage, ...th.cpu_usage, color: '#2e7d32' },
        { label: 'CPU 温度', unit: '°C', vals: h.cpu.temp, ...th.cpu_temp, color: '#e65100' },
      ]
    case 'gpu': {
      const g = h.gpu?.[s.index]
      if (!g) return []
      return [
        { label: 'GPU 占用', unit: '%', vals: g.usage, color: '#7c4dff' },
        { label: 'GPU 温度', unit: '°C', vals: g.temp, ...th.gpu_temp, color: '#e65100' },
      ]
    }
    case 'mem':
      return [{ label: '内存占用', unit: '%', vals: h.mem.percent, ...th.mem, color: '#2196f3' }]
    case 'disk':
      return [
        { label: '最大分区', unit: '%', vals: h.disk.worst, ...th.disk, color: '#00695c' },
        { label: '写入', unit: ' MB/s', vals: h.disk.io_write, color: '#8d6e63' },
      ]
    case 'link': {
      const l = h.link?.[s.target]
      if (!l) return []
      return [
        { label: 'RTT', unit: 'ms', vals: l.rtt, ...th.rtt_ms, color: '#0969da' },
        { label: '丢包', unit: '%', vals: l.loss, ...th.packet_loss, color: '#f85149' },
      ]
    }
  }
  return []
})

const fmtTs = (t) => t != null && new Date(t).toLocaleString('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
})

const fmtDur = (ms) => {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? (s % 60) + 's' : ''}`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}
</script>

<template>
  <div class="drawer">
    <div class="dw-head">
      <span>{{ title }}</span>
      <button class="dw-close" @click="$emit('close')">✕</button>
    </div>
    <div class="dw-body">

      <!-- CPU: per-core bars -->
      <div v-if="spec.kind === 'cpu'">
        <div class="dw-summary">
          总占用 {{ m.cpu?.usage_percent }}% · {{ m.cpu?.cores }} 线程（{{ m.cpu?.cores_physical ?? '?' }} 物理核）
          <template v-if="m.cpu?.temperature_c != null"> · {{ m.cpu.temperature_c }}°C</template>
        </div>
        <div class="cores" v-if="m.cpu?.per_core?.length">
          <div class="core" v-for="(p, i) in m.cpu.per_core" :key="i" :title="`核${i}: ${p}%`">
            <div class="core-bar">
              <i :class="coreClass(p)" :style="{ height: Math.max(p, 1) + '%' }" />
            </div>
            <span class="core-n">{{ i }}</span>
          </div>
        </div>
        <div v-else class="dw-empty">该 Agent 未上报分核数据（升级 Agent 后生效）</div>
      </div>

      <!-- GPU single card -->
      <div v-else-if="spec.kind === 'gpu'">
        <div v-if="gpu" class="kv-grid">
          <div class="kv" v-for="[k, v] in rows({
              '型号': gpu.name,
              '占用': gpu.usage_percent != null ? gpu.usage_percent + '%' : null,
              '显存占用率': gpu.mem_percent != null ? gpu.mem_percent + '%' : null,
              '显存': gpu.vram_total_mb ? (gpu.vram_used_mb / 1024).toFixed(1) + ' / ' + (gpu.vram_total_mb / 1024).toFixed(0) + ' GB' : null,
              '温度': gpu.temperature_c != null ? gpu.temperature_c + '°C' : null,
            })" :key="k"><b>{{ k }}</b><span>{{ v }}</span></div>
        </div>
        <div v-else class="dw-empty">无该卡数据</div>
      </div>

      <!-- Memory pool -->
      <div v-else-if="spec.kind === 'mem'">
        <div class="kv-grid" v-if="m.memory">
          <div class="kv" v-for="[k, v] in rows({
              '总容量': m.memory.total_gb + ' GB', '已用': m.memory.used_gb + ' GB',
              '可用': m.memory.available_gb + ' GB', '占用率': m.memory.percent + '%',
            })" :key="k"><b>{{ k }}</b><span>{{ v }}</span></div>
        </div>
        <div class="dw-note">内存按池呈现（双通道 interleave，单条占用不可测——产品方案 §1.3）</div>
      </div>

      <!-- Disks -->
      <div v-else-if="spec.kind === 'disk'">
        <div class="dw-summary" v-if="m.disk?.io">
          整机 IO：读 {{ m.disk.io.read_mb_s ?? '—' }} · 写 {{ m.disk.io.write_mb_s ?? '—' }} MB/s
        </div>
        <table class="dw-table" v-if="m.disk?.partitions?.length">
          <thead><tr><th>挂载点</th><th>文件系统</th><th>已用 / 总</th><th>占用</th></tr></thead>
          <tbody>
            <tr v-for="p in m.disk.partitions" :key="p.mountpoint">
              <td>{{ p.mountpoint }}</td><td>{{ p.fstype }}</td>
              <td>{{ p.used_gb }} / {{ p.total_gb }} GB</td>
              <td class="pct">
                <span class="pct-bar"><i :class="coreClass(p.percent)" :style="{ width: p.percent + '%' }" /></span>
                {{ p.percent }}%
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="dw-empty">无固定分区数据</div>
      </div>

      <!-- Network -->
      <div v-else-if="spec.kind === 'network'">
        <div class="kv-grid" v-if="m.network">
          <div class="kv" v-for="[k, v] in rows({
              '下行': m.network.download_mbps + ' Mbps', '上行': m.network.upload_mbps + ' Mbps',
              '累计发送': m.network.total_sent_gb + ' GB', '累计接收': m.network.total_recv_gb + ' GB',
            })" :key="k"><b>{{ k }}</b><span>{{ v }}</span></div>
        </div>
        <div v-else class="dw-empty">无网络指标</div>
      </div>

      <!-- Link -->
      <div v-else-if="spec.kind === 'link'">
        <div class="dw-summary" v-if="linkTarget">
          ↔{{ linkTarget.name }} · {{ linkTarget.kind.toUpperCase() }} ·
          RTT {{ linkTarget.rtt_ms ?? '无数据' }}ms · 丢包 {{ linkTarget.loss_pct ?? '—' }}% ·
          {{ STATUS_TEXT[linkTarget.level] || 'OK' }}
        </div>
      </div>

      <!-- System -->
      <div v-else-if="spec.kind === 'system'">
        <div class="kv-grid">
          <div class="kv" v-for="[k, v] in rows({
              'host_id': host.host_id, '主机名': host.hostname, '角色': ROLE_LABELS[host.role] || host.role,
              '平台': host.platform,
              '开机时长': host.metrics?.system?.uptime_seconds != null
                ? formatUptime(host.metrics.system.uptime_seconds) : null,
              '负载 (1/5/15m)': (host.metrics?.system?.load_avg || []).join(' / ') || null,
            })" :key="k"><b>{{ k }}</b><span>{{ v }}</span></div>
        </div>
        <div class="dw-note" v-if="!m.system?.load_avg">Windows 无 load average，显示为空属预期</div>
        <div class="alert-log" v-if="alertLog.length">
          <div class="al-title">本机告警史（持久化，含重启前记录）</div>
          <table class="dw-table">
            <thead><tr><th>级别</th><th>指标</th><th>状态</th><th>开始</th><th>持续</th></tr></thead>
            <tbody>
              <tr v-for="a in alertLog" :key="a.id + a.started_at">
                <td :class="'lv-' + a.level.toLowerCase()">{{ a.level }}</td>
                <td>{{ a.metric }}<template v-if="a.source !== a.metric"> @{{ a.source }}</template></td>
                <td>{{ a.state === 'active' ? '进行中' : '已恢复' }}</td>
                <td>{{ fmtTs(a.started_at) }}</td>
                <td>{{ fmtDur((a.resolved_at || Date.now()) - a.started_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- P5: server-side history trends (cpu/gpu/mem/disk/link) -->
      <div class="trend-sec" v-if="trendSeries.length">
        <div class="trend-head">
          <span>历史趋势</span>
          <span class="range-btns">
            <button v-for="r in RANGE_OPTIONS" :key="r"
                    :class="{ on: range === r }" @click="range = r">{{ r }}</button>
          </span>
        </div>
        <div class="trend-charts">
          <TrendChart v-for="s in trendSeries" :key="s.label"
                      :ts="history.ts" :vals="s.vals" :label="s.label" :unit="s.unit"
                      :warn="s.warn" :crit="s.crit" :color="s.color" />
        </div>
        <div class="dw-note" v-if="!host.online">
          节点离线，曲线为持久化历史（数据截至 {{ fmtTs(host.lastSeen) }}）
        </div>
      </div>

    </div>
  </div>
</template>

<style scoped>
.drawer {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 20;
  max-height: 42%; display: flex; flex-direction: column;
  background: var(--bg-glass); border-top: 1px solid var(--border);
  box-shadow: 0 -6px 18px rgba(0, 0, 0, .07);
  animation: slide-up .18s ease-out;
}
@keyframes slide-up { from { transform: translateY(30px); opacity: 0 } to { transform: none; opacity: 1 } }
.dw-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 14px; border-bottom: 1px solid var(--border); font-size: 13px; font-weight: 600;
}
.dw-close {
  border: 1px solid var(--border); background: none; border-radius: 6px;
  font: inherit; font-size: 12px; padding: 1px 8px; cursor: pointer; color: var(--text2);
}
.dw-close:hover { border-color: var(--accent); color: var(--accent); }
.dw-body { overflow-y: auto; padding: 10px 14px; }
.dw-summary { font-size: 12px; color: var(--text2); margin-bottom: 8px; }
.dw-empty { font-size: 12px; color: var(--text3); padding: 12px 0; }
.dw-note { font-size: 11px; color: var(--text3); margin-top: 8px; }

.cores { display: flex; flex-wrap: wrap; gap: 6px 8px; }
.core { width: 18px; text-align: center; }
.core-bar {
  height: 56px; width: 10px; margin: 0 auto; border-radius: 3px;
  background: rgba(0, 0, 0, .06); display: flex; align-items: flex-end; overflow: hidden;
}
.core-bar i { display: block; width: 100%; background: var(--green); border-radius: 3px; }
.core-bar i.warn { background: var(--orange); }
.core-bar i.crit { background: var(--red); }
.core-n { font-size: 9px; color: var(--text3); }

.kv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 6px 16px; }
.kv { font-size: 12px; display: flex; gap: 8px; }
.kv b { color: var(--text3); font-weight: 400; min-width: 62px; }

.dw-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dw-table th { text-align: left; color: var(--text3); font-weight: 400; font-size: 11px; padding: 2px 8px 4px 0; border-bottom: 1px dashed var(--border); }
.dw-table td { padding: 4px 8px 4px 0; border-bottom: 1px solid rgba(0, 0, 0, .04); }
.pct { white-space: nowrap; }
.pct-bar {
  display: inline-block; width: 70px; height: 5px; border-radius: 3px;
  background: rgba(0, 0, 0, .07); vertical-align: middle; margin-right: 6px; overflow: hidden;
}
.pct-bar i { display: block; height: 100%; background: var(--green); border-radius: 3px; }
.pct-bar i.warn { background: var(--orange); }
.pct-bar i.crit { background: var(--red); }

.trend-sec { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 8px; }
.trend-head {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 12px; font-weight: 600; color: var(--text2); margin-bottom: 6px;
}
.range-btns button {
  border: 1px solid var(--border); background: none; border-radius: 5px;
  font: inherit; font-size: 10px; padding: 1px 7px; margin-left: 4px;
  cursor: pointer; color: var(--text2);
}
.range-btns button.on { border-color: var(--accent); color: var(--accent); background: rgba(88,166,255,.08); }
.trend-charts { display: flex; flex-wrap: wrap; gap: 10px 18px; }

.alert-log { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 8px; }
.al-title { font-size: 12px; font-weight: 600; color: var(--text2); margin-bottom: 6px; }
.lv-crit { color: var(--red); font-weight: 700; }
.lv-warn { color: var(--orange); font-weight: 600; }
.lv-offline { color: var(--text3); font-weight: 600; }
</style>
