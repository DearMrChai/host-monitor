<script setup>
import { computed, ref } from 'vue'
import Sparkline from './Sparkline.vue'
import {
  hostLevel, LEVEL_RANK, ROLE_LABELS, STATUS_TEXT, formatUptime, formatReason,
  displayName, isAbsent, formatSeenLast, formatAgo, CLASS_LABELS, CLASS_HINT,
} from '../lib/status.js'
import { admin, canWrite, openDialog, rosterPost, flash } from '../lib/admin.js'
import { sparkOf } from '../lib/series.js'

const props = defineProps({ host: { type: Object, required: true } })
const emit = defineEmits(['open'])

/* No series fetching here on purpose: the overview owns the visible list and
   publishes it to lib/series.js (one poller, one request per host per 30s).
   A card that fetched for itself would multiply by however many cards fit. */
const spark = computed(() => sparkOf(props.host))

const level = computed(() => hostLevel(props.host))
const m = computed(() => props.host.metrics)
const comp = computed(() => props.host.status?.components || {})

const bars = computed(() => {
  const out = []
  const mm = m.value
  if (!mm) return out
  out.push({ key: 'CPU', value: mm.cpu?.usage_percent, level: comp.value.cpu?.level })
  out.push({ key: '内存', value: mm.memory?.percent, level: comp.value.mem?.level })
  const gpus = mm.gpu || []
  if (gpus.length) {
    const usage = gpus.map(g => g.usage_percent).filter(v => v != null)
    const gpuLevels = (comp.value.gpu || []).map(g => g.level)
    out.push({
      key: 'GPU',
      value: usage.length ? Math.max(...usage) : null,
      level: gpuLevels.reduce((a, l) =>
        (l && (!a || LEVEL_RANK[l] > LEVEL_RANK[a]) ? l : a), null),
    })
  }
  out.push({
    key: '磁盘',
    value: comp.value.disk?.worst_percent ?? null,
    level: comp.value.disk?.level,
  })
  return out
})

const reasons = computed(() => {
  const rs = props.host.status?.reasons || []
  return [...rs]
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level])
    .slice(0, 2)
})

const linkLevel = computed(() => comp.value.link?.level || null)
const linkTargets = computed(() => comp.value.link?.targets || [])
const serverRtt = computed(() =>
  linkTargets.value.find(t => t.target === 'server')?.rtt_ms ?? null)
const linkTip = computed(() => linkTargets.value.length
  ? linkTargets.value.map(t =>
      `${t.name} ${t.rtt_ms != null ? t.rtt_ms + 'ms' : '—'} 丢${t.loss_pct}%`).join(' · ')
  : '暂无链路探测数据')
const linkText = computed(() => {
  if (!linkLevel.value) return '—'
  return serverRtt.value != null ? `↘${serverRtt.value}ms` : STATUS_TEXT[linkLevel.value]
})
const uptime = computed(() => formatUptime(m.value?.system?.uptime_seconds))
const pending = computed(() => props.host.status?.pending || [])

/* ---------- S1: roster identity + minimal card operations ---------- */

const name = computed(() => displayName(props.host))
const absent = computed(() => isAbsent(props.host))
const cls = computed(() => props.host.presence_class || 'persistent')
/* Two different absences, because they are two different claims (S3 §4.2/§4.3):
   离场 = a temporary node that left, expected; 缺席 = a node the roster trusts to
   be here has not been heard from since a Server restart. The second one is the
   H12 case, so it says how long and what it does and does not affect. */
const absentLine = computed(() => {
  if (!absent.value) return null
  if (props.host.absent_record) {
    return {
      head: `缺席 · 上次在场 ${formatAgo(props.host.last_seen)}`,
      note: '计入在线率，不计入集群健康度',
    }
  }
  return {
    head: `离场 · 上次在场 ${formatSeenLast(props.host.last_seen)}`,
    note: '临时节点失联不报警',
  }
})
const mutedUntil = computed(() => (Number(props.host.muted_until) || null))
const mutedText = computed(() =>
  mutedUntil.value ? `🔕 静默至 ${formatSeenLast(mutedUntil.value)}` : '')
const locked = computed(() => !canWrite())

const menuOpen = ref(false)
const confirmStep = ref(null)
const renaming = ref(false)
const newName = ref('')

function toggleMenu() {
  menuOpen.value = !menuOpen.value
  confirmStep.value = null
  renaming.value = false
}
function closeMenu() {
  menuOpen.value = false
  confirmStep.value = null
  renaming.value = false
}

const id = computed(() => props.host.host_id)

/**
 * Items are built, not templated, so "设为临时" can disappear once it is the
 * current class and the mute label can flip in place. `confirm` on an item
 * makes it a two-step action: the first click only shows the consequence.
 */
const items = computed(() => {
  const out = []
  if (cls.value !== 'persistent') {
    out.push({ key: 'cls-persistent', label: '设为常驻', run: () => setClass('persistent') })
  }
  if (cls.value !== 'ephemeral') {
    out.push({
      key: 'cls-ephemeral', label: '设为临时',
      confirm: '改为临时后：这台机器失联只标"离场"，不再报警、不再计入在线率。确认？',
      run: () => setClass('ephemeral'),
    })
  }
  out.push(mutedUntil.value
    ? { key: 'unmute', label: '取消静默', run: () => mute({ cancel: 1 }) }
    : { key: 'mute2', label: '静默 2 小时', run: () => mute({ hours: 2 }) })
  if (!mutedUntil.value) {
    out.push({ key: 'muteday', label: '静默到今天结束', run: () => mute({ hours: 'today' }) })
  }
  out.push({ key: 'rename', label: '改名', inline: true })
  out.push({
    key: 'cls-retired', label: '退役（移出看板）',
    confirm: '退役后它不再出现在看板与任何分母里（历史仍可查）。确认？',
    run: () => setClass('retired'),
  })
  return out
})

async function setClass(next) {
  const r = await rosterPost(`/api/roster/${id.value}/class`, { cls: next }, () => setClass(next))
  if (r.ok) flash(`${name.value} → ${CLASS_LABELS[next]}`)
  closeMenu()
}

async function mute(body) {
  const r = await rosterPost(`/api/roster/${id.value}/mute`, body, () => mute(body))
  if (r.ok) flash(body.cancel ? `${name.value} 已取消静默` : `${name.value} 已静默（不进横幅与声音）`)
  closeMenu()
}

async function rename() {
  const v = newName.value.trim()
  if (!v) { closeMenu(); return }
  const r = await rosterPost(`/api/roster/${id.value}/name`, { name: v }, () => rename())
  if (r.ok) flash(`显示名已改为 ${v}`)
  closeMenu()
}

function pick(item) {
  // Writes are behind a passphrase. Rather than a dead-grey item that teaches
  // nothing, the click opens the dialog and replays this same action after it.
  if (locked.value) {
    openDialog(
      admin.passphraseSet ? '需要管理口令才能操作节点' : '先设置管理口令，才能改归类/静默/退役',
      /* Replay must land where the user was. closeMenu() below hides the menu,
         and a two-step confirm (or the inline rename field) inside a hidden
         menu is an intention that silently evaporates - so reopen it first. */
      () => { menuOpen.value = true; pick(item) },
    )
    closeMenu()
    return
  }
  if (item.inline) {
    newName.value = name.value
    renaming.value = true
    confirmStep.value = null
    return
  }
  if (item.confirm && confirmStep.value?.key !== item.key) {
    confirmStep.value = item
    return
  }
  confirmStep.value = null
  item.run()
}
</script>

<template>
  <div class="host-card" :class="['lv-' + level.toLowerCase(), { absent }]"
       @click="$emit('open', host.host_id)">
    <div class="hc-head">
      <span class="hc-name" :title="'host_id: ' + host.host_id">{{ name }}</span>
      <span class="hc-pending" v-if="pending.length"
            :title="'观察中: ' + pending.map(p => p.metric).join(', ')">观察中</span>
      <span class="hc-class" :class="cls" :title="CLASS_HINT[cls]">{{ CLASS_LABELS[cls] }}</span>
      <span class="hc-role">{{ ROLE_LABELS[host.role] || host.role || '其他' }}</span>
      <button class="hc-more" :class="{ locked }" title="节点操作"
              @click.stop="toggleMenu">⋯</button>
    </div>

    <div class="hc-absent" v-if="absentLine">
      {{ absentLine.head }}
      <em>{{ absentLine.note }}</em>
    </div>
    <div class="hc-muted" v-else-if="mutedText">{{ mutedText }}</div>

    <div class="hc-link" :title="linkTip">
      链路 <i class="lk-dot" :class="linkLevel ? linkLevel.toLowerCase() : 'na'" />
      <b :class="linkLevel ? linkLevel.toLowerCase() : 'na'">{{ linkText }}</b>
      <!-- J5's second half: the plan this box runs was inherited, and a gateway
           from another site is something it probably cannot see. This is the one
           place in V2 where the board says "I am not sure" out loud. -->
      <span class="lk-suspect" v-if="host.probe_plan_suspect"
            title="该节点没有本站点的探测计划，现在探的是 Server 所在站点的网关——换个网络下大概率探不到。可在 设置 → 该节点 指定专属计划">
        ⚠ 计划继承全局</span>
      <span class="hc-uptime" v-if="uptime">开机 {{ uptime }}</span>
    </div>

    <div class="hc-bars" v-if="m && !absent">
      <div class="hcb" v-for="b in bars" :key="b.key">
        <span class="hcb-label">{{ b.key }}</span>
        <span class="hcb-bar">
          <i class="hcb-fill" :class="b.level ? b.level.toLowerCase() : ''"
             :style="{ width: (b.value ?? 0) + '%' }" />
        </span>
        <span class="hcb-val" v-if="b.value != null">{{ Math.round(b.value) }}%</span>
        <span class="hcb-val na" v-else>—</span>
      </div>
    </div>
    <div class="hc-nodata" v-else-if="!absent">等待首帧数据…</div>

    <!-- S3b §6.2: the bars say now, this says how it got there. Hidden on absent
         cards, whose last two hours are mostly a flat line at nothing. -->
    <div class="hc-spark" v-if="spark && !absent">
      <Sparkline v-if="spark.drawn >= 2"
                 :points="spark.points" :label="spark.label" :delta="spark.delta" />
      <!-- One empty state, not two: Sparkline's own "—" is a defence, and the
           card is where the reason belongs. -->
      <span class="hcs-hint" v-else-if="spark.failed">历史读取失败</span>
      <span class="hcs-hint" v-else>2h 历史不足</span>
    </div>

    <div class="hc-reasons" v-if="reasons.length">
      <div class="hcr" v-for="(r, i) in reasons" :key="i" :class="r.level.toLowerCase()">
        {{ formatReason(r) }}<!-- J3: a red line this node's owner moved must not look
             like the fleet consensus - the next person would go edit the global
             threshold, see nothing change here, and call the tool broken. -->
        <em class="hcr-custom" v-if="r.custom"
            title="这条阈值是该机自己的设置，不是全机群共识；改它请到 设置 → 该节点">该机自定义</em>
      </div>
    </div>

    <div v-if="menuOpen" class="hc-menu" @click.stop>
      <p class="hcm-confirm" v-if="confirmStep">
        {{ confirmStep.confirm }}
        <span class="hcm-actions">
          <button @click="pick(confirmStep)">确认</button>
          <button class="ghost" @click="confirmStep = null">取消</button>
        </span>
      </p>
      <template v-else-if="renaming">
        <input v-model="newName" class="hcm-input" placeholder="显示名"
               @keyup.enter="rename()" @keyup.esc="closeMenu()" />
        <button class="hcm-item primary" @click="rename()">保存名字</button>
      </template>
      <template v-else>
        <p class="hcm-lock" v-if="locked">
          {{ admin.passphraseSet ? '需要管理口令' : '尚未设置管理口令' }}
        </p>
        <button v-for="it in items" :key="it.key" class="hcm-item"
                :class="{ danger: it.confirm }" @click="pick(it)">
          {{ it.label }}
        </button>
      </template>
    </div>
    <div v-if="menuOpen" class="hcm-backdrop" @click="closeMenu()" />
  </div>
</template>

<style scoped>
.host-card {
  background: var(--bg-glass); border: 2px solid var(--border);
  border-radius: 10px; padding: 12px 14px; cursor: pointer;
  transition: box-shadow .2s, border-color .2s;
  display: flex; flex-direction: column; gap: 8px;
  position: relative;
}
.host-card:hover { box-shadow: 0 2px 10px rgba(0,0,0,.08); }
.host-card.lv-warn    { border-color: var(--orange); }
.host-card.lv-crit    { border-color: var(--red); }
.host-card.lv-offline { border-color: var(--text3); opacity: .75; }
/* ABSENT: same grey as offline (no fifth colour) but visually "open", because
   it is not an incident — dashed border says "expected to be away". */
.host-card.absent { border-style: dashed; opacity: .62; }

.hc-head { display: flex; align-items: center; gap: 6px; }
.hc-name {
  font-size: 14px; font-weight: 600; flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hc-role {
  font-size: 10px; color: var(--text2); padding: 1px 8px; flex-shrink: 0;
  border: 1px solid var(--border); border-radius: 9px; background: var(--bg);
}
.hc-class { font-size: 10px; padding: 1px 6px; border-radius: 9px; flex-shrink: 0; }
.hc-class.persistent { color: var(--green); background: color-mix(in srgb, var(--green) 10%, transparent); }
.hc-class.ephemeral { color: var(--text2); background: rgba(0,0,0,.05); border: 1px dashed var(--border); }
.hc-pending {
  font-size: 10px; color: var(--orange); flex-shrink: 0;
  background: color-mix(in srgb, var(--orange) 12%, transparent); border-radius: 9px; padding: 1px 7px;
}
.hc-more {
  border: 1px solid transparent; background: none; color: var(--text3);
  font-size: 15px; line-height: 1; padding: 2px 6px; border-radius: 7px;
  cursor: pointer; flex-shrink: 0;
}
.hc-more:hover { border-color: var(--border); background: rgba(0,0,0,.04); }
.hc-more.locked { opacity: .45; }

.hc-absent { font-size: 11px; color: var(--text2); }
.hc-absent em { font-style: normal; color: var(--text3); margin-left: 4px; }
.hc-muted { font-size: 11px; color: var(--orange); }

.hc-link { font-size: 11px; color: var(--text3); display: flex; align-items: center; gap: 6px; }
.hc-link b { font-weight: 600; }
.lk-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
.lk-dot.na { background: var(--text3); }
.lk-dot.warn { background: var(--orange); }
.lk-dot.crit { background: var(--red); }
.lk-dot.offline { background: var(--text3); }
.hc-link b.ok { color: var(--green); }
.hc-link b.na { color: var(--text3); }
.hc-link b.warn { color: var(--orange); }
.hc-link b.crit { color: var(--red); }
.hc-link b.offline { color: var(--text3); }
/* Same ink as the rest of the link row: this is a caveat, not a fourth state -
   the dot beside it already carries the level. */
.lk-suspect { font-size: 10px; color: var(--text3); border-bottom: 1px dotted var(--text3); }
.hc-uptime { margin-left: auto; font-size: 10px; }

.hcb { display: flex; align-items: center; gap: 8px; }
.hcb-label { font-size: 11px; color: var(--text2); min-width: 30px; }
.hcb-bar { flex: 1; height: 5px; background: var(--bg); border-radius: 3px; overflow: hidden; }
.hcb-fill { display: block; height: 100%; border-radius: 3px; background: var(--green); transition: width .6s; }
.hcb-fill.warn { background: var(--orange); }
.hcb-fill.crit { background: var(--red); }
.hcb-val { font-size: 11px; min-width: 34px; text-align: right; }
.hcb-val.na { color: var(--text3); }

.hc-nodata { font-size: 12px; color: var(--text3); padding: 8px 0; }
.hc-spark {
  display: flex; align-items: center; gap: 8px;
  border-top: 1px dashed var(--border); padding-top: 5px; margin-top: -2px;
}
.hcs-hint { font-size: 10px; color: var(--text3); }
.hc-reasons { border-top: 1px dashed var(--border); padding-top: 6px; display: flex; flex-direction: column; gap: 2px; }
.hcr { font-size: 10px; color: var(--text2); }
.hcr.warn { color: var(--orange); }
.hcr.crit { color: var(--red); }
/* A tag, not a suffix inside the sentence: it has to survive the truncation of
   the reason line and read as "about this number", not as part of the value. */
.hcr-custom {
  font-style: normal; font-size: 9px; margin-left: 4px; padding: 0 4px;
  border: 1px dashed var(--text3); border-radius: 6px; color: var(--text3);
}

/* 浮层是一块地面，不是一张白纸：卡里这些字（--text/--text2/--orange/--red/--accent）
   从来就是按暗底排的，压在浅底上会一起读不出。 */
.hc-menu {
  position: absolute; top: 34px; right: 10px; z-index: 50; min-width: 172px;
  display: flex; flex-direction: column; gap: 2px; padding: 6px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 8px 26px rgba(0,0,0,.14); cursor: default;
}
.hcm-backdrop { position: fixed; inset: 0; z-index: 40; }
.hcm-item {
  font: inherit; font-size: 12px; text-align: left; cursor: pointer;
  border: none; background: none; color: var(--text); border-radius: 7px; padding: 6px 8px;
}
.hcm-item:hover { background: rgba(0,0,0,.05); }
.hcm-item.danger { color: var(--red); }
.hcm-item.primary { color: var(--accent); font-weight: 600; }
.hcm-input {
  font: inherit; font-size: 12px; padding: 5px 7px;
  border: 1px solid var(--border); border-radius: 7px; background: var(--bg); color: var(--text);
}
.hcm-lock { margin: 2px 8px 4px; font-size: 11px; color: var(--orange); }
.hcm-confirm {
  margin: 2px 4px 4px; font-size: 11px; line-height: 1.5; color: var(--text2);
  display: flex; flex-direction: column; gap: 6px;
}
.hcm-actions { display: flex; gap: 6px; }
.hcm-actions button {
  font: inherit; font-size: 11px; padding: 3px 10px; cursor: pointer;
  border-radius: 11px; border: 1px solid var(--red); background: color-mix(in srgb, var(--red) 10%, transparent); color: var(--red);
}
.hcm-actions .ghost { border-color: var(--border); background: none; color: var(--text2); }
</style>
