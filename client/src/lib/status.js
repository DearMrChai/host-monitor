/**
 * Shared four-state semantics for the frontend (P1).
 * Color codes and sort rules mirror server/src/status.js contract (P1-细化设计 §1.2).
 */

export const LEVEL_RANK = { OK: 0, WARN: 1, CRIT: 2, OFFLINE: 3 }

export const STATUS_TEXT = {
  OK: '正常', WARN: '警告', CRIT: '严重', OFFLINE: '失联',
}

export const ROLE_LABELS = {
  db: 'DB', inference: '推理', desktop: '台式',
  laptop: '笔记本', display: '展示端', other: '其他',
}

// Lower weight = more critical, listed first among equals
export const ROLE_WEIGHTS = {
  inference: 0, db: 1, desktop: 2, laptop: 3, display: 4, other: 5,
}

export function hostLevel(host) {
  return host.status?.level || (host.online ? 'OK' : 'OFFLINE')
}

export function sortHostsForOverview(hosts) {
  return [...hosts].sort((a, b) => {
    const la = hostLevel(a)
    const lb = hostLevel(b)
    if (LEVEL_RANK[lb] !== LEVEL_RANK[la]) return LEVEL_RANK[lb] - LEVEL_RANK[la]
    const wa = ROLE_WEIGHTS[a.role] ?? ROLE_WEIGHTS.other
    const wb = ROLE_WEIGHTS[b.role] ?? ROLE_WEIGHTS.other
    if (wa !== wb) return wa - wb
    return (a.hostname || a.host_id).localeCompare(b.hostname || b.host_id)
  })
}

export function formatUptime(seconds) {
  if (seconds == null) return null
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  if (d > 0) return `${d}天${h}时`
  if (h > 0) return `${h}时${Math.floor((seconds % 3600) / 60)}分`
  return `${Math.floor(seconds / 60)}分`
}

export const METRIC_LABELS = {
  cpu_usage: 'CPU占用', cpu_temp: 'CPU温度', mem: '内存',
  disk: '磁盘', gpu_temp: 'GPU温度', offline: '失联',
  rtt_ms: '链路延迟', packet_loss: '丢包率',
}

export function formatReason(r) {
  const label = METRIC_LABELS[r.metric] || r.metric
  const isLink = r.metric === 'rtt_ms' || r.metric === 'packet_loss'
  const source = isLink ? ` ↔${r.source}`
    : (r.source && !['cpu', 'mem', 'heartbeat'].includes(r.source) && r.source !== r.metric
      ? ` ${r.source}` : '')
  const unit = isLink ? (r.metric === 'rtt_ms' ? 'ms' : '%')
    : r.metric.endsWith('temp') ? '°C' : r.metric === 'offline' ? 's' : '%'
  return `${label}${source} ${r.value}${unit}（阈值 ${r.threshold}）`
}

// Device-only level (excludes link), for the topology block face color
export function deviceLevel(host) {
  if (!host.online) return 'OFFLINE'
  const c = host.status?.components || {}
  const levels = [c.cpu?.level, c.mem?.level, c.disk?.level,
    ...(c.gpu || []).map(g => g.level)].filter(Boolean)
  if (!levels.length) return null
  return levels.reduce((a, l) => (LEVEL_RANK[l] > LEVEL_RANK[a] ? l : a))
}
