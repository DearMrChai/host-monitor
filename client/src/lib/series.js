/**
 * 2h series cache for card sparklines (S3b, design §6.2-§6.3).
 *
 * Why a cache and not a fetch per card: the overview redraws on every 2s
 * snapshot, and refetching 96 history points per card per snapshot would be 30x
 * the traffic for data that moves once a minute. History is a *slow* channel by
 * design (the fast one is the WS snapshot), so it gets its own 30s poll, one
 * request at a time, for the cards that are actually on screen.
 *
 * The batch endpoint deliberately was not added (S3 §6.2): 3-7 cards x 96 points
 * every 30s is nothing for SQLite, and `POST /api/history/batch` would be a
 * second query path to keep in sync for no measured gain.
 */
import { reactive } from 'vue'

const RANGE = '2h'
const POLL_MS = 30_000
const MAX_HOSTS = 12

/** host_id -> { ts, cpu, mem, gpu, fetchedAt, failed } */
const cache = reactive({})

const interest = new Set()
let timer = null
let pumpRunning = false
let seq = 0

function due(now = Date.now()) {
  return [...interest].filter((id) => {
    const e = cache[id]
    return !e || now - e.fetchedAt > POLL_MS
  }).slice(0, MAX_HOSTS)
}

async function pump() {
  if (pumpRunning) return
  pumpRunning = true
  const mine = ++seq
  try {
    for (const hostId of due()) {
      if (mine !== seq) break // interest changed while we were in flight
      let entry = cache[hostId]
      if (!entry) entry = cache[hostId] = { fetchedAt: 0, failed: false }
      try {
        const res = await fetch(`/api/history/${encodeURIComponent(hostId)}?range=${RANGE}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const d = await res.json()
        entry.ts = d.ts || []
        entry.cpu = d.cpu?.usage || []
        entry.mem = d.mem?.percent || []
        // GPU index 0 only: a second line per card is legibility debt, and the
        // 142's per-GPU detail already lives in its 3D view.
        entry.gpu = d.gpu?.[0]?.usage || []
        entry.fetchedAt = Date.now()
        entry.failed = false
      } catch {
        // A retry stamp of "now" is the difference between one failed poll and a
        // request storm: keep the old points, back off for one interval.
        entry.fetchedAt = Date.now()
        entry.failed = true
      }
    }
  } finally {
    pumpRunning = false
  }
}

/** The ids on screen, in card order (most significant first). */
export function setInterest(ids) {
  const next = new Set(ids)
  let changed = false
  for (const id of next) if (!interest.has(id)) { interest.add(id); changed = true }
  for (const id of [...interest]) if (!next.has(id)) { interest.delete(id); changed = true }
  if (changed) pump()
}

export function start() {
  if (!timer) {
    pump()
    timer = setInterval(pump, POLL_MS)
  }
}

export function stop() {
  clearInterval(timer)
  timer = null
}

const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null)

/** Mean of the newest `n` non-null points, or null when there are too few. */
function meanTail(arr, n) {
  if (!arr || !arr.length) return null
  const vals = []
  for (let i = arr.length - 1; i >= 0 && vals.length < n; i--) {
    if (arr[i] != null) vals.push(arr[i])
  }
  if (vals.length < Math.min(n, 3)) return null
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

/**
 * "近 30 分钟 vs 前 30 分钟" inside the 2h window, i.e. the newest quarter
 * against the one before it. Direction colour is never a four-state colour
 * (S3 §6.3): a rising temperature is not the same claim as a CRIT.
 */
function deltaOf(arr) {
  const n = Math.max(2, Math.floor((arr?.length || 0) / 4))
  if (!arr || arr.length < n * 2) return null
  const now = meanTail(arr, n)
  const before = meanTail(arr.slice(0, arr.length - n), n)
  if (now == null || before == null || before === 0) return null
  const pct = Math.round(((now - before) / before) * 100)
  return { pct, dir: pct >= 5 ? 'up' : pct <= -5 ? 'down' : 'flat' }
}

/**
 * The card's primary series: whichever of CPU / GPU / 内存 is carrying the most
 * right now, so the line and the arrow describe the thing a viewer would ask
 * about. Falls back to CPU for absent nodes (their last-known load is the point).
 */
export function sparkOf(host) {
  const entry = cache[host.host_id]
  if (!entry || !entry.ts?.length) return null
  const c = last(host.metrics?.cpu?.usage_percent)
  const m = last(host.metrics?.memory?.percent)
  const g = Math.max(-1, ...(host.metrics?.gpu || []).map((x) => x.usage_percent ?? -1))
  const ranked = [
    { key: 'cpu', label: 'CPU', value: c ?? -1 },
    { key: 'gpu', label: 'GPU', value: g },
    { key: 'mem', label: '内存', value: m ?? -1 },
  ].sort((a, b) => b.value - a.value)
  const pick = ranked[0].value >= 0
    ? ranked[0]
    : { key: 'cpu', label: 'CPU', value: null }
  const points = entry[pick.key] || []
  return {
    label: pick.label,
    key: pick.key,
    points,
    // How much of that array is actually drawable. `points.length` counts the
    // aligned buckets, and a freshly started Server hands out two buckets that
    // are both null - enough to satisfy a `.length` guard, not enough to draw.
    drawn: points.reduce((n, v) => (v == null ? n : n + 1), 0),
    failed: !!entry.failed,
    delta: deltaOf(points),
  }
}

/** Normalised polyline coords for Sparkline.vue: gaps where a bucket is empty. */
export function coords(points, w = 100, h = 24) {
  const n = points.length
  if (n < 2) return []
  const vals = points.filter((v) => v != null)
  if (!vals.length) return []
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  const span = hi - lo || 1
  const out = []
  points.forEach((v, i) => {
    if (v == null) { out.push(null); return }
    out.push([
      (i / (n - 1)) * w,
      h - ((v - lo) / span) * (h - 2) - 1,
    ])
  })
  return out
}

export { cache }
