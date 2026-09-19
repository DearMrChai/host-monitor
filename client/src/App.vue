<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import OverviewView from './views/OverviewView.vue'
import TopologyView from './views/TopologyView.vue'
import DetailView from './views/DetailView.vue'
import EnrollView from './views/EnrollView.vue'
import ClusterBar from './components/ClusterBar.vue'
import AlertBanner from './components/AlertBanner.vue'
import PassphraseDialog from './components/PassphraseDialog.vue'
import { LEVEL_RANK } from './lib/status.js'
import { admin, syncAdmin } from './lib/admin.js'
import { unlock, playWarn, playCrit, setCritLoop } from './lib/sound.js'

/* App shell (P1-P3): owns the single WebSocket to the server, the view
   state machine (overview <-> topology <-> detail), the shared top bar /
   alert banner and alert sound dispatch. */

/* Server WS lives on the same host as the page, fixed port 9101 (client HTTP+WS
   server). Derives from location so LAN access (http://<server-ip>:5173) works. */
const SERVER_WS = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname || 'localhost'}:9101`
const SERVER_API = '/api/hosts'

const hosts = ref([])
const cluster = ref(null)
const alerts = ref({ active: [], resolved: [] })
const thresholds = ref({})
const newNodes = ref([])
const connected = ref(false)
const route = ref({ name: 'overview', hostId: null, from: 'overview' })

const currentHost = computed(() =>
  hosts.value.find(h => h.host_id === route.value.hostId) || null,
)

/* Where a detail page returns to. A list of names, not a ternary per view: S2c
   added 接入 as a third origin and the old form silently dropped it. */
const ORIGINS = ['topology', 'enroll']

function openDetail(hostId) {
  route.value = {
    name: 'detail', hostId,
    from: ORIGINS.includes(route.value.name) ? route.value.name : 'overview',
  }
}

function setView(name) {
  route.value = { name, hostId: null, from: name }
}

function backFromDetail() {
  const to = ORIGINS.includes(route.value.from) ? route.value.from : 'overview'
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
  newNodes.value = msg.new_nodes || []
  syncAdmin(msg)
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
      if (data.admin) syncAdmin(data)
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
                  :pending-count="newNodes.length"
                  @toggle="setView" @goto-pending="setView('overview')" />
      <AlertBanner :alerts="alerts.active || []" @open="id => openDetail(id)" />
    </template>
    <OverviewView v-if="route.name === 'overview'"
                  class="app-main" :hosts="hosts" :alerts="alerts" :new-nodes="newNodes"
                  @open="openDetail" />
    <TopologyView v-else-if="route.name === 'topology'"
                  class="app-main" :hosts="hosts"
                  @open="openDetail" />
    <EnrollView v-else-if="route.name === 'enroll'"
                class="app-main" :hosts="hosts"
                @open="openDetail" />
    <DetailView v-else class="app-main"
                :host="currentHost" :connected="connected" :from="route.from"
                :alerts="alerts" :thresholds="thresholds" @back="backFromDetail" />

    <!-- Write results land here: the roster edits are fire-and-forget HTTP, and
         a silent failure on "退役" is the worst possible outcome. -->
    <transition name="flash">
      <div v-if="admin.flash" class="app-flash" :class="admin.flash.kind">{{ admin.flash.text }}</div>
    </transition>
    <PassphraseDialog />
  </div>
</template>

<style>
.app-shell { height: 100%; display: flex; flex-direction: column; }
.app-main { flex: 1; min-height: 0; }
.app-flash {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 90;
  font-size: 12px; padding: 7px 14px; border-radius: 16px; pointer-events: none;
  background: var(--bg-glass); border: 1px solid var(--border); color: var(--text);
  box-shadow: 0 6px 20px rgba(0,0,0,.12);
}
.app-flash.err { border-color: var(--red); color: #b62324; }
.flash-enter-active, .flash-leave-active { transition: opacity .25s, transform .25s; }
.flash-enter-from, .flash-leave-to { opacity: 0; transform: translateX(-50%) translateY(6px); }
</style>
