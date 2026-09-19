/**
 * The 24h event stream, client side (S3b).
 * Contract: S3-细化设计.md §5-§6.1.
 *
 * One shared store, not one fetch per panel: the overview rail and a node's
 * detail page show the same stream filtered differently, and the 接入 page wants
 * just its `ingest` rows. Polling it three times would triple the server work to
 * render one fact, and the three copies would disagree between polls.
 *
 * Filtering happens here rather than via `?host=` because the stream is small
 * (400-row cap server side, 7-day retention) and one response already carries
 * every node's rows. If a fleet ever grows past that, the server-side filter is
 * implemented and this becomes a query parameter - no other change needed.
 */
import { reactive, computed } from 'vue'

const POLL_MS = 15_000
const LIMIT = 200

export const KIND_TABS = [
  { key: 'all', label: '全部' },
  { key: 'alert', label: '告警' },
  { key: 'presence', label: '在场' },
  { key: 'ingest', label: '接入' },
  { key: 'roster', label: '名册' },
]

export const WINDOWS = ['24h', '7d']

const stream = reactive({
  window: '24h',
  kind: 'all',
  events: [],
  persisted: true,
  count: 0,
  truncated: false,
  error: null,
  fetchedAt: 0,
  loading: false,
})

let timer = null
let subscribers = 0
let inflight = null
let warned = false

async function load() {
  if (inflight) return inflight
  stream.loading = true
  try {
    const res = await fetch(`/api/events?window=${stream.window}&limit=${LIMIT}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    stream.events = Array.isArray(data.events) ? data.events : []
    stream.persisted = data.persisted !== false
    stream.count = data.count ?? stream.events.length
    stream.truncated = !!data.truncated
    stream.error = null
    stream.fetchedAt = Date.now()
    warned = false
  } catch (e) {
    // Keep the last good rows: an empty stream because the Server is restarting
    // is a lie of the same shape as the one S3 exists to remove.
    stream.error = e.message
    /* The console is where a 掉帧/取数失败 belongs - not the event stream, which
       holds facts about the fleet, not about this browser tab (S4 §1.4). Logged
       once per streak so a Server restart does not fill the log. */
    if (!warned) {
      warned = true
      console.warn('[events] 事件流读取失败，界面显示的是上一次成功的记录:', e.message)
    }
  } finally {
    stream.loading = false
    inflight = null
  }
  return stream.events
}

export function setWindow(w) {
  if (!WINDOWS.includes(w) || stream.window === w) return
  stream.window = w
  load()
}

export function setKind(k) {
  if (!KIND_TABS.some((t) => t.key === k)) return
  stream.kind = k
}

/** Refcounted: the poller runs while at least one panel is mounted. */
export function subscribe() {
  subscribers += 1
  if (subscribers === 1) {
    load()
    timer = setInterval(load, POLL_MS)
  } else if (Date.now() - stream.fetchedAt > POLL_MS) {
    load() // a panel opened long after the first one must not show hour-old rows
  }
}

export function unsubscribe() {
  subscribers = Math.max(0, subscribers - 1)
  if (subscribers === 0) {
    clearInterval(timer)
    timer = null
  }
}

export const refresh = load

/**
 * How old the shared store is, for anyone who must not turn a fetch failure into
 * a reassurance. The kiosk needs this: the wall reads "24h 内没有变化" as
 * "nothing is wrong", and an empty list because the poll has been failing for an
 * hour is exactly the H12-shaped lie S3 exists to remove (S4 §2.3).
 *
 * `now` is an input, not a hidden Date.now(): a view that already keeps one
 * clock must not create a second, or the event line and the 停止刷新 banner can
 * disagree about what time it is.
 */
export function streamAgeMs(now = Date.now()) {
  return stream.fetchedAt ? Math.max(0, now - stream.fetchedAt) : null
}

export function eventsFor(hostId = null, kind = stream.kind) {
  const rows = hostId ? stream.events.filter((e) => e.host_id === hostId) : stream.events
  if (kind === 'all') return rows
  return rows.filter((e) => e.kind === kind)
}

/** Reactive view helper for components: `const rows = useEvents(hostId)`. */
export function useEvents(hostIdGetter) {
  return computed(() => eventsFor(
    typeof hostIdGetter === 'function' ? hostIdGetter() : hostIdGetter,
  ))
}

export { stream }
