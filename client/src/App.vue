<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import OverviewView from './views/OverviewView.vue'
import TopologyView from './views/TopologyView.vue'
import DetailView from './views/DetailView.vue'
import ClusterBar from './components/ClusterBar.vue'
import AlertBanner from './components/AlertBanner.vue'
import { LEVEL_RANK } from './lib/status.js'
import { unlock, playWarn, playCrit, setCritLoop } from './lib/sound.js'

/* App shell (P1-P3): owns the single WebSocket to the server, the view
   state machine (overview <-> topology <-> detail), the shared top bar /
   alert banner and alert sound dispatch. */

const SERVER_WS = 'ws://localhost:9101'
const SERVER_API = '/api/hosts'

const hosts = ref([])
const cluster = ref(null)
const alerts = ref({ active: [], resolved: [] })
const thresholds = ref({})
const connected = ref(false)
const route = ref({ name: 'overview', hostId: null, from: 'overview' })

const currentHost = computed(() =>
  hosts.value.find(h => h.host_id === route.value.hostId) || null,
)

function openDetail(hostId) {
  route.value = {
    name: 'detail', hostId,
    from: route.value.name === 'topology' ? 'topology' : 'overview',
  }
}

function setView(name) {
  route.value = { name, hostId: null, from: name }
}

function backFromDetail() {
  const to = route.value.from === 'topology' ? 'topology' : 'overview'
  route.value = { name: to, hostId: null, from: to }
}

/* ---------- Alert sounds (diff by alert id + level) ---------- */

const knownLevels = new Map()

function handleSounds(active) {
  for (const a of active) {
    const prev = knownLevels.get(a.id)
    if (prev === undefined || LEVEL_RANK[a.level] > LEVEL_RANK[prev]) {
      if (a.level === 'WARN') playWarn()
      else playCrit()
    }
    knownLevels.set(a.id, a.level)
  }
  const liveIds = new Set(active.map(a => a.id))
  for (const id of [...knownLevels.keys()]) {
    if (!liveIds.has(id)) knownLevels.delete(id)
  }
  setCritLoop(active.some(a => a.level === 'CRIT' || a.level === 'OFFLINE'))
}

let ws = null
let reconnectTimer = null
let unlockListener = null

function applySnapshot(msg) {
  if (msg.type !== 'snapshot') return
  hosts.value = msg.hosts || []
  cluster.value = msg.cluster || null
  alerts.value = msg.alerts || { active: [], resolved: [] }
  if (msg.thresholds) thresholds.value = msg.thresholds
  handleSounds(alerts.value.active || [])
}

function connect() {
  if (ws && ws.readyState <= 1) return
  try {
    ws = new WebSocket(SERVER_WS)
    ws.onopen = () => { connected.value = true }
    ws.onmessage = (evt) => {
      try {
        applySnapshot(JSON.parse(evt.data))
      } catch (e) {
        console.error('[Client] Parse error:', e)
      }
    }
    ws.onclose = () => {
      connected.value = false
      scheduleReconnect()
    }
    ws.onerror = () => { ws?.close() }
  } catch (e) {
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, 3000)
}

onMounted(async () => {
  unlockListener = () => unlock()
  window.addEventListener('pointerdown', unlockListener, { passive: true })

  try {
    const res = await fetch(SERVER_API)
    if (res.ok) {
      const data = await res.json()
      if (data.hosts) hosts.value = data.hosts
      if (data.cluster) cluster.value = data.cluster
    }
  } catch (e) { /* WS will take over */ }
  connect()
})

onBeforeUnmount(() => {
  if (ws) { ws.onclose = null; ws.close() }
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (unlockListener) window.removeEventListener('pointerdown', unlockListener)
  setCritLoop(false)
})
</script>

<template>
  <div class="app-shell">
    <template v-if="route.name !== 'detail'">
      <ClusterBar :cluster="cluster" :connected="connected" :view="route.name"
                  @toggle="setView" />
      <AlertBanner :alerts="alerts.active || []" @open="id => openDetail(id)" />
    </template>
    <OverviewView v-if="route.name === 'overview'"
                  class="app-main" :hosts="hosts" :alerts="alerts"
                  @open="openDetail" />
    <TopologyView v-else-if="route.name === 'topology'"
                  class="app-main" :hosts="hosts"
                  @open="openDetail" />
    <DetailView v-else class="app-main"
                :host="currentHost" :connected="connected"
                :alerts="alerts" :thresholds="thresholds" @back="backFromDetail" />
  </div>
</template>

<style>
.app-shell { height: 100%; display: flex; flex-direction: column; }
.app-main { flex: 1; min-height: 0; }
</style>
