<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import OverviewView from './views/OverviewView.vue'
import DetailView from './views/DetailView.vue'

/* App shell (P1): owns the single WebSocket to the server and the
   view state machine (overview <-> detail). No vue-router. */

const SERVER_WS = 'ws://localhost:9101'
const SERVER_API = '/api/hosts'

const hosts = ref([])
const cluster = ref(null)
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

let ws = null
let reconnectTimer = null

function applySnapshot(msg) {
  if (msg.type !== 'snapshot') return
  hosts.value = msg.hosts || []
  cluster.value = msg.cluster || null
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
})
</script>

<template>
  <OverviewView v-if="route.name === 'overview'"
                :hosts="hosts" :cluster="cluster" :connected="connected"
                @open="openDetail" />
  <DetailView v-else :host="currentHost" :connected="connected" @back="backToOverview" />
</template>
