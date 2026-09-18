<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import OverviewView from './views/OverviewView.vue'
import DetailView from './views/DetailView.vue'
import { LEVEL_RANK } from './lib/status.js'
import { unlock, playWarn, playCrit, setCritLoop } from './lib/sound.js'

/* App shell (P1/P2): owns the single WebSocket to the server, the
   view state machine (overview <-> detail) and alert sound dispatch. */

const SERVER_WS = 'ws://localhost:9101'
const SERVER_API = '/api/hosts'

const hosts = ref([])
const cluster = ref(null)
const alerts = ref({ active: [], resolved: [] })
const connected = ref(false)
const route = ref({ name: 'overview', hostId: null })

const currentHost = computed(() =>
  hosts.value.find(h => h.host_id === route.value.hostId) || null,
)

function openDetail(hostId) {
  route.value = { name: 'detail', hostId }
}

function backToOverview() {
  route.value = { name: 'overview', hostId: null }
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
  <OverviewView v-if="route.name === 'overview'"
                :hosts="hosts" :cluster="cluster" :alerts="alerts" :connected="connected"
                @open="openDetail" />
  <DetailView v-else :host="currentHost" :connected="connected" @back="backToOverview" />
</template>
