<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { ClusterTopologyRenderer } from '../three/ClusterTopologyRenderer.js'
import { topologyViewModel, topologyTiles } from '../lib/topology-vm.js'
import { createFpsGuard } from '../lib/fps.js'
import { stream, streamAgeMs, subscribe, unsubscribe } from '../lib/events.js'
import { admin } from '../lib/admin.js'
import { sound, toggleMute, unlock } from '../lib/sound.js'
import { STATUS_TEXT, displayName, formatSeenLast, shortName } from '../lib/status.js'

/**
 * KioskView (S4) — the 值守屏, i.e. density tier L0
 * =================================================
 * One job: answer "有没有事 / 几台在" from three metres away, forever, on a
 * machine that is never restarted and never touched. Everything that is not that
 * answer stayed in the other views — no 钻取, no editing, no threshold numbers,
 * no host_id or address of any kind (§2.5).
 *
 * It is also the only view whose worst failure is *lying*: a wall that keeps
 * showing a healthy scene after the feed died is worse than a black screen,
 * because a black screen gets investigated. §2.3 is therefore load-bearing
 * functionality here, not polish.
 */

const props = defineProps({
  hosts: { type: Array, default: () => [] },
  cluster: { type: Object, default: null },
  /* When the WS snapshot last arrived, stamped by the App shell that owns the
     socket. Deliberately the only freshness input: `connected` cannot answer
     "is this picture current", because a socket that is open and silent is the
     exact case that boolean cannot see — the Server can be up and deaf, and the
     browser can be happily connected to it. So it is not passed at all. */
  lastSnapshotAt: { type: Number, default: 0 },
  /* ?kiosk&flat=1 - the CSS wall by hand. Doubles as the self-test for the
     degrade path, which otherwise needs a genuinely slow GPU to trigger. */
  forceFlat: { type: Boolean, default: false },
})

const FPS_CAP = 30     // §1.4: a status wall is not a game; half the GPU for free
const FPS_MIN = 20     // below this rolling mean, WebGL is fired
const L0_NAME_MAX = 8  // §1.3: 节点名 ≤8 字
const STALE_AFTER_S = 10 // 5 missed 2s snapshots: the picture is no longer current
const POLL_STALE_MS = 90_000 // 6 missed polls: the event line can no longer speak

/* 'scene' -> 'flat' is one-way. A machine that dipped under the threshold will
   dip again, and an oscillating wall is a second, worse version of the same
   problem: the viewer stops trusting what they see. */
const mode = ref(props.forceFlat ? 'flat' : 'scene')
const flatReason = ref('')
const ctxLost = ref(false)
const viewport = ref(null)

/* One clock for the whole view, advanced by a single 1s ticker (see onMounted).
   The staleness counter and the event line's age both read `now`, so the two can
   never disagree about what time it is - and no computed here calls Date.now()
   directly, because that would make its value depend on wall time while Vue has
   no reason to re-run it. */
const now = ref(Date.now())

let renderer = null
let guard = null
let tickTimer = null
let ctxTimer = null

/* ---------- how old is the picture? (§2.3) ---------- */

/* lastSnapshotAt === 0 means nothing has ever arrived, i.e. this is not an
   expired picture but an absent one - and 0 would compute an age of "now",
   which is nonsense. The header already says 集群失联 with no data behind it,
   which is the honest version of the same fact; the banner is for the worse
   case, where there *is* a picture and it has quietly stopped being current. */
const staleSec = computed(() =>
  Math.max(0, Math.round((now.value - (props.lastSnapshotAt || now.value)) / 1000)))
const stale = computed(() => staleSec.value > STALE_AFTER_S)
const staleText = computed(() => {
  const s = staleSec.value
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`
})

/* ---------- top line ---------- */

const health = computed(() => props.cluster?.health || 'OFFLINE')
/* ClusterBar's rule, unchanged: total===0 is not 正常 (S1b). */
const empty = computed(() => !!props.cluster && props.cluster.total === 0)
const healthText = computed(() =>
  empty.value ? '无常驻节点' : '集群' + STATUS_TEXT[health.value])
const onlineText = computed(() =>
  (!props.cluster || empty.value ? '—' : `${props.cluster.online}/${props.cluster.total}`))

/* The wall hangs on a 副屏 in a room that other people see. The Server already
   redacts addresses from event text (S3 §5), which is a strong guarantee for
   today's data and a weak one for tomorrow's - so the display layer checks the
   shape it is about to magnify to 20px. It drops the line rather than masking
   it: a half-hidden "10.***.***.***" would only teach the viewer that something
   is being hidden from them. */
function addressShaped(s) {
  return /(?:\d{1,3}\.){3}\d{1,3}/.test(s)
    || /\b(?:host_id|hostname|ip|addr|mac|port|token|secret)\b/i.test(s)
    || /:\/\//.test(s)
}

const eventLine = computed(() => {
  // An event line that cannot be refreshed must say so instead of showing the
  // last thing that happened as if it were the current state. Read off the same
  // clock as the 停止刷新 banner, so the two stale notices cannot disagree.
  const age = streamAgeMs(now.value)
  if (age == null) return { kind: 'loading', text: '事件流尚未取到' }
  if (age > POLL_STALE_MS) {
    return { kind: 'stale', text: `事件流已停止更新 ${Math.round(age / 60_000)} 分钟` }
  }
  const e = stream.events.find((r) => r?.text && !addressShaped(String(r.text)))
  if (!e) {
    if (!stream.persisted) return { kind: 'none', text: '事件流未落盘（history 关闭）' }
    return { kind: 'none', text: '24 小时内机群没有变化' }
  }
  const who = e.host_name || displayName({ host_id: e.host_id })
  const what = String(e.text)
  /* Presence rows are written "<name> 离场（…）": prefixing the name again would
     say it twice on the line where every character costs the most. */
  const named = (e.host_id && what.startsWith(e.host_id)) || what.startsWith(who)
  return {
    kind: e.level || 'OK',
    text: `${formatSeenLast(e.ts)} ${shortName(named ? what : `${who} ${what}`, 40)}`,
  }
})

/* ---------- bottom aggregate: ClusterBar's three bars, enlarged ---------- */

const bars = computed(() => {
  const agg = props.cluster?.aggregate
  if (!agg) return []
  return [
    { key: 'CPU', data: agg.cpu },
    { key: '内存', data: agg.mem },
    { key: 'GPU', data: agg.gpu },
  ]
})

/* ---------- the flat wall (fallback and forced mode) ---------- */

/* Scene and wall read the *same* view-model calls, so a degraded panel is a
   different density of one truth rather than a second opinion on it. The only
   thing this view adds is the CSS class casing. */
const sceneNodes = computed(() =>
  topologyViewModel(props.hosts, { nameMax: L0_NAME_MAX }))

const tiles = computed(() => topologyTiles(props.hosts, { nameMax: L0_NAME_MAX })
  .map((t) => ({ ...t, level: t.level.toLowerCase() })))

/* The layout is positional, so a data change has to redraw the ring - not just
   re-render the DOM around it. */
watch(sceneNodes, (nodes) => {
  if (mode.value === 'scene') renderer?.update(nodes)
})

/* ---------- WebGL scene ---------- */

function mountScene() {
  if (renderer || mode.value !== 'scene') return
  renderer = new ClusterTopologyRenderer(viewport.value, {
    interactive: false, fpsCap: FPS_CAP,
  })
  renderer.update(sceneNodes.value)

  guard = createFpsGuard({
    threshold: FPS_MIN,
    onDegrade: (info) => degradeToFlat(
      `${info.spanSec.toFixed(0)} 秒内平均 ${info.fps.toFixed(1)}fps，低于 ${FPS_MIN}fps`),
  })
  /* 掉帧与取数失败是这一屏自己的事，不是机群事实：只进 console，不进事件流
     (§1.4)，否则一次显卡抖动会污染一份本该只装机群事件的台账。 */
  renderer.onFrame = () => guard?.tick()
  renderer.onContextLost = () => {
    ctxLost.value = true
    console.warn('[kiosk] WebGL 上下文丢失，画面停在最后一次成功渲染，10 秒内尝试恢复')
    clearTimeout(ctxTimer)
    ctxTimer = setTimeout(() => {
      if (ctxLost.value) degradeToFlat('显卡上下文丢失且未能恢复')
    }, 10_000)
  }
  renderer.onContextRestored = () => {
    ctxLost.value = false
    clearTimeout(ctxTimer)
    ctxTimer = null
    console.warn('[kiosk] WebGL 上下文已恢复')
  }
  guard.start()
}

function degradeToFlat(reason) {
  flatReason.value = reason
  mode.value = 'flat'
  guard?.stop()
  // Dispose really drops the canvas: a degraded wall must not keep a GL context,
  // a render loop and a set of buffers alive out of politeness.
  renderer?.dispose()
  renderer = null
}

function onSound() {
  unlock()
  if (!sound.unlocked) return
  toggleMute()
}

onMounted(async () => {
  subscribe()
  if (mode.value === 'scene') {
    // The stage must be laid out before the renderer measures it.
    await nextTick()
    mountScene()
  } else {
    flatReason.value = '手动指定 ?flat=1（跳过 3D）'
  }
  tickTimer = setInterval(() => { now.value = Date.now() }, 1000)
})

onBeforeUnmount(() => {
  unsubscribe()
  clearInterval(tickTimer)
  clearTimeout(ctxTimer)
  guard?.stop()
  renderer?.dispose()
  renderer = null
})
</script>

<template>
  <div class="kiosk" :class="{ stale }">
    <header class="k-top">
      <span class="k-health" :class="[empty ? 'offline' : health.toLowerCase(), { beat: !empty && health === 'CRIT' }]">
        {{ healthText }}
      </span>
      <span class="k-online">在线 <b>{{ onlineText }}</b></span>
      <!-- 道具必须在最亮的一行里自报身份（决策 4：撑门面的东西不许被读成真机） -->
      <span class="k-demo" v-if="admin.demo.enabled"
            :title="`${admin.demo.count} 台演示道具在场：计入告警，不计入健康度与在线率`">
        演示道具 {{ admin.demo.count }}
      </span>
      <span class="k-event" :class="eventLine.kind">{{ eventLine.text }}</span>
      <span class="k-spacer" />
      <!-- kiosk never auto-unlocks audio (browser policy forbids it), so the only
           honest control is a mute toggle that shows which way it currently goes. -->
      <button class="k-sound" :class="{ muted: sound.muted }"
              :title="!sound.unlocked ? '浏览器要求先与页面交互才能出声' : (sound.muted ? '取消静音' : '静音')"
              @click="onSound">
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <path d="M4 9.5h3l5-4.2v13.4l-5-4.2H4z" :fill="sound.muted ? 'var(--text3)' : 'var(--text2)'" />
          <path d="M16.6 8.6c1.5 1.1 1.5 5.7 0 6.8" fill="none" stroke-width="2" stroke-linecap="round"
                :stroke="sound.muted ? 'var(--text3)' : 'var(--text2)'"
                :stroke-opacity="!sound.unlocked ? 0.35 : 1" />
          <path v-if="sound.muted" d="M20.6 9.4l4 5.2m0-5.2l-4 5.2" stroke="var(--text3)"
                stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>
    </header>

    <main class="k-stage">
      <div ref="viewport" class="k-viewport" v-show="mode === 'scene'" />

      <div class="k-wall" v-if="mode === 'flat'">
        <div class="k-tile" v-for="t in tiles" :key="t.id" :class="'lv-' + t.level">
          <span class="k-t-name">{{ t.name }}</span>
          <span class="k-t-val" v-if="t.value != null">{{ t.value }}<em>%</em></span>
          <span class="k-t-val na" v-else>—</span>
          <span class="k-t-note" v-if="t.note">{{ t.note }}</span>
        </div>
        <p class="k-empty" v-if="!tiles.length">
          还没有节点上报
          <em>Agent 尚未接入，或名册里的节点都已被退役</em>
        </p>
      </div>

      <!-- 降级必须可见（§1.4 禁则 3）：静默换脸会让"为什么漂亮的那版不见了"变成
           一个新隐患 -->
      <p class="k-why" v-if="mode === 'flat'">已降级 · 动效关闭<em>{{ flatReason }}</em></p>
      <p class="k-why lost" v-else-if="ctxLost">显卡上下文丢失，正在恢复…<em>画面停在最后一次成功渲染</em></p>

      <!-- §2.3: while the feed is dead this is the loudest thing on screen -->
      <div class="k-stale" v-if="stale">
        已停止刷新 {{ staleText }} · 画面为最后一次快照
        <em>正在重连 Server。这段时间内发生的事不会显示在这里。</em>
      </div>
    </main>

    <footer class="k-bottom" v-if="bars.length">
      <div class="k-agg" v-for="b in bars" :key="b.key">
        <span class="k-agg-label">{{ b.key }}</span>
        <span class="k-agg-bar">
          <i class="k-agg-peak" v-if="b.data.peak != null" :style="{ left: b.data.peak + '%' }" />
          <i class="k-agg-fill" :style="{ width: (b.data.avg ?? 0) + '%' }" />
        </span>
        <span class="k-agg-val" v-if="b.data.avg != null">{{ Math.round(b.data.avg) }}<em>%</em></span>
        <span class="k-agg-val na" v-else>—</span>
      </div>
    </footer>
  </div>
</template>

<style scoped>
/* L0's floor sizes are a contract, not a preference (§1.3): 26px status, 20px
   numbers, read at three metres. max() holds that floor on a 1080p 副屏 and lets
   it grow on a larger panel without anyone re-tuning it.
   Nothing here uses backdrop-filter: full-screen per-frame compositing is the
   single easiest way to fall under 20fps on a GT 1030 (禁则 2). */
.kiosk {
  height: 100%; display: flex; flex-direction: column;
  background: var(--bg); color: var(--text); overflow: hidden;
}
/* 灰档 without a filter chain on the canvas: dimming is one solid overlay. */
.kiosk.stale .k-viewport, .kiosk.stale .k-wall { opacity: .55; }

.k-top {
  display: flex; align-items: center; gap: max(14px, 1.4vw);
  padding: 10px max(16px, 1.6vw) 8px;
  border-bottom: 1px solid var(--border); background: var(--bg-glass);
}
.k-health {
  font-size: max(26px, 1.9vw); font-weight: 700; letter-spacing: 1px;
  padding: 2px 16px; border-radius: 8px; border: 2px solid;
}
.k-health.ok { color: var(--ok-ink); border-color: var(--green); background: rgba(30,140,50,.08); }
.k-health.warn { color: var(--warn-ink); border-color: var(--orange); background: rgba(210,153,34,.10); }
.k-health.crit { color: var(--crit-ink); border-color: var(--red); background: rgba(248,81,73,.10); }
.k-health.offline { color: var(--text2); border-color: var(--text3); background: rgba(0,0,0,.04); }
/* The screen's one DOM animation, spent on what must be noticed from across a
   room. The 3D pulses live inside the scene's own budget (§1.4). */
.k-health.beat { animation: k-beat 1s ease-in-out infinite; }
@keyframes k-beat { 0%,100% { opacity: 1 } 50% { opacity: .45 } }

.k-online { font-size: max(20px, 1.5vw); color: var(--text2); white-space: nowrap; }
.k-online b { color: var(--text); font-variant-numeric: tabular-nums; }
.k-demo {
  font-size: max(14px, .95vw); padding: 3px 10px; border-radius: 12px;
  border: 1px dashed var(--text3); color: var(--text3); white-space: nowrap;
}
.k-event {
  font-size: max(16px, 1.05vw); color: var(--text2); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.k-event.warn { color: var(--warn-ink); }
.k-event.crit, .k-event.offline { color: var(--crit-ink); }
.k-event.stale { color: var(--warn-ink); }
.k-event.none, .k-event.loading { color: var(--text3); }
.k-spacer { flex: 1; min-width: 8px; }
.k-sound {
  border: 1px solid var(--border); background: var(--bg-glass);
  border-radius: 10px; padding: 4px 6px; cursor: pointer; line-height: 0; flex-shrink: 0;
}
.k-sound.muted { opacity: .6; }

.k-stage { flex: 1; min-height: 0; position: relative; }
.k-viewport { position: absolute; inset: 0; }
.k-wall {
  position: absolute; inset: 0; display: grid; gap: 14px; padding: 18px;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  align-content: center;
}
.k-tile {
  border: 2px solid var(--border); border-radius: 12px; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 2px; min-height: 96px;
  background: var(--bg-glass);
}
.k-tile.lv-warn { border-color: var(--orange); }
.k-tile.lv-crit { border-color: var(--red); }
.k-tile.lv-offline { border-color: var(--text3); }
/* Same trick as the cards: 缺席 shares 失联's grey, differs by shape. */
.k-tile.lv-absent { border-style: dashed; opacity: .62; }
.k-t-name { font-size: max(20px, 1.4vw); font-weight: 600; }
.k-t-val { font-size: max(26px, 2vw); font-weight: 700; font-variant-numeric: tabular-nums; }
.k-t-val.na { color: var(--text3); }
.k-t-note { font-size: max(13px, .9vw); color: var(--text2); }
.k-t-val em, .k-agg-val em { font-style: normal; font-size: .55em; color: var(--text3); margin-left: 2px; }
.k-empty {
  grid-column: 1 / -1; text-align: center; color: var(--text2);
  font-size: max(16px, 1.1vw); display: flex; flex-direction: column; gap: 6px;
}
.k-empty em { font-style: normal; font-size: .72em; color: var(--text3); }

.k-why {
  position: absolute; left: 16px; bottom: 12px; z-index: 6;
  display: flex; flex-direction: column; gap: 2px;
  font-size: max(13px, .95vw); color: var(--warn-ink);
  border: 1px solid var(--orange); border-radius: 8px; padding: 5px 10px;
  background: var(--bg-glass);
}
.k-why em { font-style: normal; color: var(--text3); font-size: .85em; }
.k-why.lost { border-color: var(--red); color: var(--crit-ink); }

.k-stale {
  position: absolute; inset: 0; z-index: 8; display: flex;
  flex-direction: column; align-items: center; gap: 8px; padding-top: 11vh;
  background: rgba(245, 240, 230, .55); text-align: center;
  font-size: max(26px, 1.9vw); font-weight: 700; letter-spacing: 1px;
  color: var(--crit-ink);
}
.k-stale em { font-style: normal; font-size: .5em; font-weight: 400; color: var(--text2); }

.k-bottom {
  display: flex; align-items: center; gap: max(20px, 2.4vw);
  padding: 10px max(18px, 2vw); border-top: 1px solid var(--border);
  background: var(--bg-glass);
}
.k-agg { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.k-agg-label { font-size: max(14px, .95vw); color: var(--text2); }
.k-agg-bar {
  position: relative; flex: 1; height: 10px; min-width: 60px;
  border-radius: 5px; background: rgba(0,0,0,.07); overflow: hidden;
}
.k-agg-fill {
  position: absolute; inset: 0 auto 0 0; background: var(--green);
  border-radius: 5px; transition: width .6s ease;
}
.k-agg-peak { position: absolute; top: 0; bottom: 0; width: 3px; background: rgba(0,0,0,.35); }
.k-agg-val {
  font-size: max(20px, 1.5vw); font-variant-numeric: tabular-nums;
  min-width: 3.4em; text-align: right;
}
.k-agg-val.na { color: var(--text3); }
</style>

<style>
/* Unscoped on purpose: the CSS2D label divs are created inside three.js and
   appended to the container, so they never receive this component's scope
   attribute. The plate has to reach the L0 floor here too - 11px is a reading
   distance the kiosk does not have. */
[data-kiosk] .topo-label { padding: 6px 14px; border-radius: 8px; }
[data-kiosk] .topo-label .tl-name { font-size: 20px; }
[data-kiosk] .topo-label .tl-sub { font-size: 15px; margin-top: 3px; }
</style>
