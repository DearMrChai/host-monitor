<script setup>
import { computed } from 'vue'
import { STATUS_TEXT, ROLE_LABELS, formatUptime } from '../lib/status.js'

/* V3 drawer: bottom slide-out with per-component / per-link detail (P4).
   Only "current window" data — history curves arrive with P5. */

const props = defineProps({
  host: { type: Object, required: true },
  spec: { type: Object, required: true },   // {kind, index?, target?, name?}
  thresholds: { type: Object, default: () => ({}) },
  rttHistory: { type: Array, default: () => [] },  // recent rtt_ms samples for link kind
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

/* RTT mini chart: 60-point window, log-free linear scale */
const chart = computed(() => {
  const pts = props.rttHistory.slice(-60)
  if (!pts.length) return null
  const th = props.thresholds.rtt_ms || { warn: 5, crit: 50 }
  const max = Math.max(th.crit * 1.2, ...pts, 1)
  const W = 260, H = 64
  const x = (i) => pts.length === 1 ? W / 2 : (i / (pts.length - 1)) * W
  const y = (v) => H - (v / max) * (H - 6) - 3
  const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return {
    W, H, line, max,
    warnY: y(th.warn).toFixed(1), critY: y(th.crit).toFixed(1),
    thWarn: th.warn, thCrit: th.crit,
  }
})

const rows = (obj) => Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)
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
        <svg v-if="chart" class="rtt-chart" :viewBox="`0 0 ${chart.W} ${chart.H}`">
          <line :y1="chart.warnY" :y2="chart.warnY" x1="0" :x2="chart.W" class="th-warn" />
          <line :y1="chart.critY" :y2="chart.critY" x1="0" :x2="chart.W" class="th-crit" />
          <polyline :points="chart.line" class="rtt-line" />
          <text x="2" :y="chart.warnY - 2" class="th-label">{{ chart.thWarn }}ms</text>
          <text x="2" :y="chart.critY - 2" class="th-label">{{ chart.thCrit }}ms</text>
        </svg>
        <div class="dw-note">近 {{ Math.min(rttHistory.length, 60) }} 个广播帧（约 {{ Math.min(rttHistory.length, 60) * 2 }}s）客户端窗口，历史曲线见 P5</div>
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

.rtt-chart { width: 100%; max-width: 420px; height: 72px; background: rgba(0, 0, 0, .03); border-radius: 6px; }
.rtt-line { fill: none; stroke: var(--accent); stroke-width: 1.5; }
.th-warn { stroke: var(--orange); stroke-dasharray: 3 3; stroke-width: .8; }
.th-crit { stroke: var(--red); stroke-dasharray: 3 3; stroke-width: .8; }
.th-label { font-size: 7px; fill: var(--text3); }
</style>
