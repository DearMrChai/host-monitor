<script setup>
import { computed, onMounted, onBeforeUnmount } from 'vue'
import { formatSeenLast, displayName, eventNamesHost } from '../lib/status.js'
import {
  stream, KIND_TABS, WINDOWS, subscribe, unsubscribe, setKind, setWindow, refresh,
} from '../lib/events.js'

/* The 24h stream (S3b, design §6.1): one line per thing that changed.
   It deliberately does not show "what is true now" - that is the grid's job -
   so a quiet fleet's honest answer is an empty list, not a list of OK rows. */

const props = defineProps({
  /* A node detail page passes its own host_id; the overview rail passes null. */
  hostId: { type: String, default: null },
  title: { type: String, default: '机群事件' },
  /* The rail is 260px wide and shares the column with the alert panel, so it
     gets the tight variant; the detail page can afford roomier rows. */
  compact: { type: Boolean, default: false },
  maxRows: { type: Number, default: 40 },
  /* The 接入 page wants one category and no chips (a locked ledger, not a
     browser). Locking filters locally instead of writing stream.kind, or
     "只看接入" on that page would silently filter the overview too. */
  lockKind: { type: String, default: null },
})
defineEmits(['open'])

const kind = computed(() => props.lockKind || stream.kind)

onMounted(subscribe)
onBeforeUnmount(unsubscribe)

const rows = computed(() => {
  const src = stream.events.filter((e) =>
    (props.hostId ? e.host_id === props.hostId : true)
    && (kind.value === 'all' ? true : e.kind === kind.value))
  return src.slice(0, props.maxRows)
})

const noneAtAll = computed(() => !stream.events.length)
const emptyText = computed(() => {
  // Three different silences, three different sentences - "暂无数据" would let a
  // disabled history DB read as a healthy fleet (S3 §6.1).
  const span = stream.window === '7d' ? '7 天' : '24 小时'
  if (!stream.persisted) return '事件流未落盘（history 关闭），重启后不会有记录'
  if (rows.value.length) return ''
  if (!noneAtAll.value && kind.value !== 'all') return `这一类在${span}内没有记录`
  return props.hostId
    ? `这台机器这 ${span}没有变化`
    : `这 ${span}机群没有任何变化`
})

/** "09:12 起 · 34 次" - the merge window is a fact about the fleet, not noise. */
function counted(e) {
  if ((e.count || 1) <= 1) return ''
  const first = formatSeenLast(e.first_ts || e.ts)
  const last = formatSeenLast(e.ts)
  return `×${e.count}${first !== last ? `（${first} 起）` : ''}`
}

function who(e) {
  return e.host_name || displayName({ host_id: e.host_id })
}
</script>

<template>
  <section class="event-stream" :class="{ tight: compact }">
    <header class="es-head">
      <span class="es-title" v-if="title">{{ title }}<em v-if="rows.length">{{ rows.length }}</em></span>
      <span class="es-win">
        <button v-for="w in WINDOWS" :key="w" :class="{ on: stream.window === w }"
                :title="w === '24h' ? '近 24 小时' : '近 7 天（保留期上限）'"
                @click="setWindow(w)">{{ w }}</button>
      </span>
      <button class="es-refresh" :class="{ busy: stream.loading }" title="立即刷新"
              @click="refresh()">⟳</button>
    </header>

    <nav class="es-kinds" v-if="!lockKind">
      <button v-for="k in KIND_TABS" :key="k.key" :class="{ on: kind === k.key }"
              @click="setKind(k.key)">{{ k.label }}</button>
      <span class="es-at" v-if="stream.fetchedAt && !stream.error">
        {{ formatSeenLast(stream.fetchedAt) }} 更新
      </span>
      <span class="es-at err" v-else-if="stream.error">{{ stream.error }}</span>
    </nav>

    <div v-if="emptyText" class="es-empty">{{ emptyText }}</div>

    <ul v-else class="es-list">
      <li v-for="(e, i) in rows" :key="e.ts + '-' + e.code + '-' + (e.host_id || '') + i"
          :class="[e.level, { clickable: !hostId && e.host_id }]"
          @click="!hostId && e.host_id && $emit('open', e.host_id)">
        <i class="es-dot" />
        <span class="es-time">{{ formatSeenLast(e.ts) }}</span>
        <span class="es-who" v-if="!hostId && e.host_id && !eventNamesHost(e)" :title="'host_id: ' + e.host_id">{{ who(e) }}</span>
        <span class="es-text">{{ e.text }}</span>
        <span class="es-count" v-if="counted(e)">{{ counted(e) }}</span>
      </li>
    </ul>
    <p class="es-more" v-if="stream.truncated && rows.length">
      只列出最近 {{ maxRows }} 条（服务端窗口内尚有更早的记录）
    </p>
  </section>
</template>

<script>
/* Separate <script> block: the component needs `emits` declared next to props,
   and <script setup> already owns the binding - this is just the options. */
export default { name: 'EventStream', emits: ['open'] }
</script>

<style scoped>
.event-stream {
  background: var(--bg-glass); border: 1px solid var(--border); border-radius: 10px;
  padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; min-height: 0;
}
.es-head { display: flex; align-items: center; gap: 8px; }
.es-title { font-size: 13px; font-weight: 600; }
.es-title em {
  font-style: normal; font-size: 11px; color: var(--text2);
  background: var(--bg); border-radius: 9px; padding: 0 7px; margin-left: 5px;
}
.es-win { margin-left: auto; display: flex; border: 1px solid var(--border); border-radius: 11px; overflow: hidden; }
.es-win button {
  font: inherit; font-size: 11px; border: none; cursor: pointer;
  padding: 1px 9px; background: none; color: var(--text2);
}
.es-win button.on { background: var(--accent); color: #fff; }
.es-refresh {
  font: inherit; font-size: 12px; line-height: 1; cursor: pointer; padding: 2px 6px;
  border: 1px solid var(--border); border-radius: 9px; background: none; color: var(--text2);
}
.es-refresh.busy { opacity: .45; }

.es-kinds { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.es-kinds button {
  font: inherit; font-size: 11px; cursor: pointer; padding: 1px 8px;
  border: 1px solid transparent; border-radius: 9px; background: var(--bg); color: var(--text2);
}
.es-kinds button.on { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.es-at { margin-left: auto; font-size: 10px; color: var(--text3); }
.es-at.err { color: var(--red); }

.es-empty { font-size: 11px; color: var(--text3); padding: 10px 2px; }

.es-list { list-style: none; display: flex; flex-direction: column; gap: 1px; min-height: 0; }
.es-list li {
  display: flex; align-items: baseline; gap: 6px; font-size: 11px;
  padding: 3px 4px; border-radius: 6px;
}
.es-list li.clickable:hover { background: rgba(0,0,0,.04); }
.es-list li.clickable { cursor: pointer; }
.es-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text3); flex-shrink: 0; }
.es-list li.warn .es-dot { background: var(--orange); }
.es-list li.crit .es-dot { background: var(--red); }
.es-time { color: var(--text3); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.es-who { font-weight: 600; flex-shrink: 0; max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.es-text { color: var(--text2); flex: 1; min-width: 0; }
.es-list li.warn .es-text { color: var(--orange); }
.es-list li.crit .es-text { color: var(--red); }
.es-count { font-size: 10px; color: var(--text3); flex-shrink: 0; }

.es-more { font-size: 10px; color: var(--text3); }
.tight .es-list li { padding: 2px 3px; }
</style>
