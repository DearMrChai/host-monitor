<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import ProbePlanEditor from '../components/ProbePlanEditor.vue'
import { METRIC_LABELS, unitFor, CLASS_LABELS, CLASS_HINT, displayName } from '../lib/status.js'
import { admin, adminGet, canWrite, openDialog, rosterPost, flash } from '../lib/admin.js'

/* S6 §5 设置页：左=全局，右=选中节点。
 *
 * Three rules shaped this file, and all three come from the server's contract
 * rather than from taste:
 *  - `setThresholds` and `setProbes` are **whole-object replacements**, so the
 *    two forms each own exactly one 应用 button that sends the entire document.
 *    A per-row save would silently delete the rows it did not mention.
 *  - The open read (`/api/config`) masks probe targets. A form over masked
 *    values is a way to destroy the link arm by pressing 保存, so when the read
 *    was masked the plan forms are read-only and say why (S5 G3).
 *  - Validation refuses, it does not correct. A blank *threshold* box therefore
 *    travels as `null` and comes back named ("此项需在 x~y 之间") rather than
 *    being quietly refilled with the old number; a blank optional scalar the
 *    server never had stays out of the payload, because refusing a form nobody
 *    touched is not honesty either.
 */

const props = defineProps({
  hosts: { type: Array, default: () => [] },
})

const SCALAR_LABELS = {
  offline_seconds: '失联判定（秒）',
  'alert.debounce_cycles': '告警去抖（帧）',
  'alert.resolved_keep_minutes': '已恢复保留（分）',
  'alert.history_capacity': '告警历史条数',
  'alert.tick_ms': '评估周期（毫秒）',
  'alert.unknown_alert_grace_minutes': '陌生告警宽限（分）',
  'events.merge_seconds': '事件合并窗口（秒）',
  'presence.absent_after_minutes': 'ZT 缺席判定（分）',
  'presence.degrade_after_minutes': 'ZT 静默降级（分）',
}
const PLAN_SOURCE = {
  node: '该机专属计划', site: '本站点计划', global: '全局计划', none: '服务器未下发',
}

const doc = ref(null)
const masked = ref(true)
const loading = ref(false)
const thForm = ref({})
const presenceOn = ref(true)
const planForm = ref(null)
const confirmReset = ref(false)
const sel = ref(null)
const pf = ref({ display_name: '', owner: '', site: '', role: '' })
const nover = ref({})
const nplan = ref(null)
const muteHours = ref(4)

const metrics = computed(() => doc.value?.spec?.metrics || [])
const scalars = computed(() => doc.value?.spec?.scalars || [])
const nodes = computed(() => doc.value?.nodes || [])
const node = computed(() => nodes.value.find(n => n.host_id === sel.value) || null)
const liveHost = computed(() => props.hosts.find(h => h.host_id === sel.value) || null)
const writable = computed(() => canWrite())

function deepGet(o, dotted) {
  return dotted.split('.').reduce((a, k) => (a == null ? a : a[k]), o)
}
function deepSet(o, dotted, v) {
  const keys = dotted.split('.')
  const last = keys.pop()
  let n = o
  // Descend *and* create: without the reassignment the leaf lands next to the
  // parent instead of inside it, and the server answers "未知配置项 warn" - which
  // is exactly what the first browser pass of this page produced.
  for (const k of keys) {
    n[k] = (n[k] && typeof n[k] === 'object') ? n[k] : {}
    n = n[k]
  }
  n[last] = v
}
const shown = (v) => (v === undefined || v === null ? '' : String(v))
/* '' -> null is the deliberate choice: the server refuses null with the row's
   own name, which is a conversation. Refilling it here would be the silent
   correction this design rejected. */
const num = (s) => (String(s ?? '').trim() === '' ? null : Number(s))

async function load() {
  loading.value = true
  let j = null
  masked.value = true
  if (canWrite()) {
    const r = await adminGet('/api/admin/config')
    if (r.ok) { j = r.json; masked.value = false }
  }
  if (!j) {
    try {
      const res = await fetch('/api/config')
      if (res.ok) j = await res.json()
    } catch { /* the next snapshot says "server unreachable" louder */ }
  }
  if (j) {
    doc.value = j
    const f = {}
    for (const m of j.spec?.metrics || []) {
      for (const side of ['warn', 'crit']) f[`${m.key}.${side}`] = shown(deepGet(j.thresholds, `${m.key}.${side}`))
    }
    for (const s of j.spec?.scalars || []) f[s.key] = shown(deepGet(j.thresholds, s.key))
    thForm.value = f
    presenceOn.value = j.thresholds?.presence?.enabled !== false
    planForm.value = j.probes ? JSON.parse(JSON.stringify(j.probes)) : null
    if (!sel.value || !j.nodes?.some(n => n.host_id === sel.value)) {
      sel.value = j.nodes?.[0]?.host_id || null
    }
    syncNode()
  }
  loading.value = false
}

/** Re-pull the node forms from the server document. Called after every accepted
 *  write, because the truth about "what is live now" is the server's, and a form
 *  that keeps its own copy after a save can save an old one over it. */
function syncNode() {
  const n = node.value
  pf.value = {
    display_name: n?.display_name || '', owner: n?.owner || '',
    site: n?.site || '', role: n?.role || '',
  }
  const map = {}
  for (const m of metrics.value) {
    const o = n?.thresholds?.[m.key]
    map[m.key] = { warn: shown(o?.warn), crit: shown(o?.crit) }
  }
  nover.value = map
  nplan.value = n?.probes ? JSON.parse(JSON.stringify(n.probes)) : null
}
watch(sel, syncNode)
/* The passphrase can arrive mid-page (the dialog is one click away), and the
   masked read is strictly worse than the real one — so the moment the gate
   opens, this page upgrades its own picture instead of waiting for a reload. */
watch(writable, (v) => { if (v && masked.value) load() })

function guard(what, again) {
  if (canWrite()) return true
  openDialog(admin.passphraseSet ? `需要管理口令才能${what}` : `先设置管理口令，才能${what}`,
    again || (() => load()))
  return false
}

/* ---------- global writes ---------- */

function thresholdsPayload() {
  const out = JSON.parse(JSON.stringify(doc.value?.thresholds || {}))
  for (const m of metrics.value) {
    // Metric pairs travel even when blank: the evaluator dereferences
    // `th.cpu_usage.crit`, so "no CPU red line" is not a state this form may
    // create - a blank box has to come back as a refusal, not as a missing key.
    for (const side of ['warn', 'crit']) deepSet(out, `${m.key}.${side}`, num(thForm.value[`${m.key}.${side}`]))
  }
  for (const s of scalars.value) {
    const blank = String(thForm.value[s.key] ?? '').trim() === ''
    const had = deepGet(doc.value?.thresholds, s.key) !== undefined
    // An optional scalar that was never set (unknown_alert_grace_minutes) has no
    // number to keep: sending null there would refuse a form nobody touched.
    if (blank && !had) continue
    deepSet(out, s.key, num(thForm.value[s.key]))
  }
  out.presence = { ...(out.presence || {}), enabled: presenceOn.value }
  return out
}

async function saveThresholds() {
  if (!guard('应用全局阈值', saveThresholds)) return
  const r = await rosterPost('/api/admin/config/thresholds', { thresholds: thresholdsPayload() })
  if (r.ok) {
    flash(r.json?.changed?.length
      ? `已应用，改动了 ${r.json.changed.length} 项：下一帧判级即用新值`
      : '已应用（数值与当前一致，无改动）')
    await load()
  }
}

async function resetThresholds() {
  if (!confirmReset.value) { confirmReset.value = true; setTimeout(() => { confirmReset.value = false }, 6000); return }
  if (!guard('回落播种值', resetThresholds)) return
  const r = await rosterPost('/api/admin/config/thresholds', { reset: true })
  if (r.ok) { flash('已回落到 thresholds.json 的播种值'); confirmReset.value = false; await load() }
}

async function saveProbes() {
  if (!guard('保存探测计划', saveProbes)) return
  const r = await rosterPost('/api/admin/config/probes', { probes: planForm.value })
  // The honest timing (design §4): an Agent picks its plan up when it registers.
  if (r.ok) { flash('全局探测计划已写入；Agent 下次接入时生效'); await load() }
}

function newGlobalPlan() {
  planForm.value = { gateway: { name: '网关', host: '', tcp_port: null }, key_hosts: [] }
}

/* ---------- node writes ---------- */

async function saveProfile() {
  if (!guard('改档案', saveProfile)) return
  const before = node.value || {}
  const patch = {}
  for (const k of ['display_name', 'owner', 'site', 'role']) {
    const v = String(pf.value[k] ?? '').trim()
    if (v !== (before[k] ?? '')) patch[k] = v
  }
  if (!Object.keys(patch).length) { flash('档案没有改动'); return }
  const r = await rosterPost(`/api/roster/${encodeURIComponent(sel.value)}/settings`, patch)
  if (r.ok) { flash(`已更新：${Object.keys(patch).join('、')}`); await load() }
}

async function setClass(cls) {
  if (!guard('改归类', () => setClass(cls))) return
  const r = await rosterPost(`/api/roster/${encodeURIComponent(sel.value)}/class`, { cls })
  if (r.ok) { flash(`${displayName(node.value)} → ${CLASS_LABELS[cls]}`); await load() }
}

async function setMute(body) {
  if (!guard('设置静默', () => setMute(body))) return
  const r = await rosterPost(`/api/roster/${encodeURIComponent(sel.value)}/mute`, body)
  if (r.ok) { flash(body.cancel ? '已解除该机静默' : '该机阈值告警已静默（失联不受静默影响）'); await load() }
}

function overridesPayload() {
  const out = {}
  for (const m of metrics.value) {
    const pair = nover.value[m.key] || {}
    const clean = {}
    for (const side of ['warn', 'crit']) {
      const v = num(pair[side])
      if (v !== null) clean[side] = v
    }
    if (Object.keys(clean).length) out[m.key] = clean
  }
  return out
}

async function saveOverrides() {
  if (!guard('设置该机阈值', saveOverrides)) return
  const r = await rosterPost(`/api/roster/${encodeURIComponent(sel.value)}/thresholds`,
    { thresholds: overridesPayload() })
  if (r.ok) {
    flash(r.json?.custom?.length
      ? `该机自定义阈值已生效：${r.json.custom.map(k => METRIC_LABELS[k] || k).join('、')}`
      : '该机覆盖已全部清空，回落全局值')
    await load()
  }
}

async function clearOverrides() {
  if (!guard('清空该机阈值', clearOverrides)) return
  const r = await rosterPost(`/api/roster/${encodeURIComponent(sel.value)}/thresholds`, { thresholds: null })
  if (r.ok) { flash('已清空：该机全部回落全局阈值'); await load() }
}

async function saveNodePlan() {
  if (!guard('设置该机探测计划', saveNodePlan)) return
  const r = await rosterPost(`/api/roster/${encodeURIComponent(sel.value)}/probes`, { probes: nplan.value })
  if (r.ok) { flash('该机探测计划已写入；Agent 下次接入时生效'); await load() }
}

async function clearNodePlan() {
  if (!guard('清除该机探测计划', clearNodePlan)) return
  const r = await rosterPost(`/api/roster/${encodeURIComponent(sel.value)}/probes`, { probes: null })
  if (r.ok) { flash('已清除：该机回落到站点/全局派生的计划'); await load() }
}

/* ---------- read-only helpers ---------- */

const globalCustom = computed(() => {
  const out = []
  for (const n of nodes.value) if (n.thresholds && Object.keys(n.thresholds).length) out.push(n.display_name || n.host_id)
  return out
})
const overridden = computed(() => metrics.value.some(m => {
  const p = nover.value[m.key] || {}
  return String(p.warn ?? '').trim() !== '' || String(p.crit ?? '').trim() !== ''
}))
const mutedText = computed(() => {
  const until = node.value?.muted_until
  if (!until) return null
  const min = Math.max(0, Math.round((until - Date.now()) / 60000))
  return min >= 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分` : `${min} 分钟`
})
const headNote = computed(() => (loading.value ? '读取中…' : `${nodes.value.length} 台在册`))

onMounted(load)
</script>

<template>
  <div class="settings">
    <div v-if="!writable" class="sv-gate">
      当前只读：{{ admin.passphraseSet ? '这台浏览器里没有存管理口令——点右上 🔑 输入后即可编辑'
        : '服务端还没设管理口令——点右上 🔑 设置后即可编辑' }}。
      只读视图里的探测目标是掩码（<code>*.*</code>），因为总览页对局域网开放。
    </div>

    <div class="sv-body">
      <!-- ========================= left: global ========================= -->
      <main class="sv-col">
        <section class="sv-card">
          <h3>全局阈值 <em>整套提交：一次改动一次生效，不留半套状态</em></h3>
          <div class="sv-table">
            <div class="sv-tr sv-th">
              <span>指标</span><span>警告档</span><span>严重档</span><span>单位</span>
            </div>
            <div class="sv-tr" v-for="m in metrics" :key="m.key">
              <span class="sv-td">{{ METRIC_LABELS[m.key] || m.key }}</span>
              <input v-model="thForm[`${m.key}.warn`]" class="sv-in" inputmode="decimal"
                     :placeholder="`${m.min}~${m.max}`">
              <input v-model="thForm[`${m.key}.crit`]" class="sv-in" inputmode="decimal"
                     :placeholder="`${m.min}~${m.max}`">
              <span class="sv-unit">{{ unitFor(m.key) }}｜界 {{ m.min }}~{{ m.max }}</span>
            </div>
          </div>

          <div class="sv-sub">判定与窗口</div>
          <div class="sv-grid">
            <label v-for="s in scalars" :key="s.key" class="sv-cell">
              <span>{{ SCALAR_LABELS[s.key] || s.key }}</span>
              <input v-model="thForm[s.key]" class="sv-in wide" inputmode="numeric"
                     :placeholder="`${s.min}~${s.max}`">
            </label>
            <label class="sv-cell">
              <span>ZT 在场台账启用</span>
              <select v-model="presenceOn" class="sv-in wide">
                <option :value="true">启用</option>
                <option :value="false">停用</option>
              </select>
            </label>
          </div>

          <div class="sv-actions">
            <button class="sv-primary" @click="saveThresholds">应用全局阈值</button>
            <button :class="['sv-alt', { armed: confirmReset }]" @click="resetThresholds">
              {{ confirmReset ? '确认回落到文件播种值？' : '回落到播种值' }}
            </button>
            <span class="sv-note" v-if="doc && doc.untouched_since_seed">
              仍是 <code>thresholds.json</code> 的播种值（DB 还没有这一行）
            </span>
            <span class="sv-note" v-else-if="doc">
              已由设置页/接口写入 DB：文件不再被读取（H9）
            </span>
          </div>
          <p class="sv-note" v-if="globalCustom.length">
            有 {{ globalCustom.length }} 台机器带自定义阈值：{{ globalCustom.join('、') }}
            ——它们的告警行上会标"该机自定义"。
          </p>
        </section>

        <section class="sv-card">
          <h3>全局探测计划 <em>没有专属/站点计划的机器都用它</em></h3>
          <ProbePlanEditor v-if="planForm" :plan="planForm" :masked="masked" />
          <p v-else class="sv-note">
            这台 Server 还没有全局探测计划（既无 DB 行也无 <code>probes.json</code>）：
            Agent 只探 Server 一条臂。
          </p>
          <div class="sv-actions">
            <button v-if="!planForm" class="sv-alt" @click="newGlobalPlan">新建全局探测计划</button>
            <button v-if="planForm" class="sv-primary" :disabled="masked" @click="saveProbes">
              保存全局计划
            </button>
            <span class="sv-note">保存后在 Agent 下次接入时生效（不是立即换目标）</span>
          </div>
        </section>
      </main>

      <!-- ========================= right: one node ========================= -->
      <aside class="sv-col">
        <section class="sv-card">
          <h3>节点 <em>{{ headNote }}</em></h3>
          <div class="sv-nodes">
            <button v-for="n in nodes" :key="n.host_id" class="sv-node" :class="{ on: n.host_id === sel }"
                    @click="sel = n.host_id">
              {{ n.display_name || n.host_id }}
              <i v-if="n.thresholds && Object.keys(n.thresholds).length">阈</i>
              <i v-if="n.probes">探</i>
            </button>
          </div>
          <p v-if="!nodes.length" class="sv-note">名册里还没有节点。</p>

          <template v-if="node">
            <div class="sv-meta">
              <code>{{ node.host_id }}</code>
              <span>{{ CLASS_LABELS[node.presence_class] || node.presence_class }}</span>
              <span v-if="node.site">站点 {{ node.site }}</span>
              <span v-if="liveHost?.probe_plan_source">
                当前计划来源：{{ PLAN_SOURCE[liveHost.probe_plan_source] || liveHost.probe_plan_source }}
              </span>
              <span class="sv-suspect" v-if="liveHost?.probe_plan_suspect">
                ⚠ 继承的是别的站点的计划
              </span>
              <span class="sv-muted" v-if="mutedText">静默至 {{ mutedText }} 后</span>
            </div>

            <div class="sv-sub">档案</div>
            <label class="sv-cell col">
              <span>显示名</span><input v-model="pf.display_name" class="sv-in wide" maxlength="40">
            </label>
            <div class="sv-pair">
              <label class="sv-cell col"><span>归属</span>
                <input v-model="pf.owner" class="sv-in wide" maxlength="20" placeholder="谁的机器"></label>
              <label class="sv-cell col"><span>站点</span>
                <input v-model="pf.site" class="sv-in wide" maxlength="20" placeholder="home / office"></label>
            </div>
            <p class="sv-note">站点名需为小写字母/数字/-/_，它同时是探测计划表的键。</p>
            <div class="sv-actions">
              <button class="sv-primary" @click="saveProfile">保存档案</button>
              <select class="sv-in" :value="node.presence_class" @change="setClass($event.target.value)">
                <option v-for="(t, c) in CLASS_LABELS" :key="c" :value="c">{{ t }}</option>
              </select>
            </div>
            <p class="sv-note">{{ CLASS_HINT[node.presence_class] || '' }}</p>

            <div class="sv-sub">告警静默</div>
            <div class="sv-actions">
              <select v-model.number="muteHours" class="sv-in">
                <option :value="1">1 小时</option><option :value="4">4 小时</option>
                <option :value="8">8 小时</option><option :value="24">24 小时</option>
              </select>
              <button class="sv-alt" @click="setMute({ hours: muteHours })">静默阈值告警</button>
              <button class="sv-alt" @click="setMute({ hours: 'today' })">今晚为止</button>
              <button v-if="mutedText" class="sv-alt" @click="setMute({ cancel: true })">解除静默</button>
            </div>

            <div class="sv-sub">阈值覆盖 <em>留空即沿用全局；只填一侧也只改那一侧</em></div>
            <div class="sv-table">
              <div class="sv-tr sv-th"><span>指标</span><span>警告档</span><span>严重档</span><span>全局</span></div>
              <div class="sv-tr" v-for="m in metrics" :key="m.key">
                <span class="sv-td">{{ METRIC_LABELS[m.key] || m.key }}</span>
                <input v-model="nover[m.key].warn" class="sv-in" inputmode="decimal"
                       :placeholder="`${deepGet(doc?.thresholds, `${m.key}.warn`) ?? '—'}`">
                <input v-model="nover[m.key].crit" class="sv-in" inputmode="decimal"
                       :placeholder="`${deepGet(doc?.thresholds, `${m.key}.crit`) ?? '—'}`">
                <span class="sv-unit">{{ unitFor(m.key) }}</span>
              </div>
            </div>
            <div class="sv-actions">
              <button class="sv-primary" @click="saveOverrides">保存该机阈值</button>
              <button v-if="overridden" class="sv-alt" @click="clearOverrides">全部改回继承</button>
            </div>

            <div class="sv-sub">该机探测计划 <em>不填则按 站点 → 全局 派生</em></div>
            <ProbePlanEditor v-if="nplan" :plan="nplan" :masked="masked" inherit-timing />
            <p v-else class="sv-note">
              {{ node.probes ? '该机有专属计划。' : '该机没有专属计划，当前用派生结果（见上方"当前计划来源"）。' }}
            </p>
            <div class="sv-actions">
              <button v-if="!nplan" class="sv-alt" @click="nplan = { gateway: null, key_hosts: [] }">
                为该机指定专属计划
              </button>
              <button v-if="nplan" class="sv-primary" :disabled="masked" @click="saveNodePlan">
                保存该机计划
              </button>
              <button v-if="nplan" class="sv-alt" @click="clearNodePlan">改回派生</button>
              <span class="sv-note" v-if="nplan">保存后在 Agent 下次接入时生效</span>
            </div>
          </template>
        </section>

        <section class="sv-card sv-help">
          <h3>这些数字从哪儿来 <em>一期只到"改得动"，不到"审批流"</em></h3>
          <ul>
            <li>写下去的是运行时真源：下一帧判级即用，不需要重启 Server。</li>
            <li>回滚不是点一下：代码回退到上一版而 DB 里已有这些行时，改过的值仍然生效——先清 <code>settings</code> 行再回滚（见部署说明）。</li>
            <li>本机不加密：口令只挡住误操作与路过的人，局域网是明文，形态 A（不暴露公网）下接受这一点。</li>
            <li>Server 重启后、Agent 尚未回连的那段窗口里，旧告警会被标成"该机未再上报"：仍挂在列表面前，但不响铃、不闪红点；宽限期到点自行标记失效（绝不写成"已恢复"）。嫌它挂太久就把"陌生告警宽限"调小。</li>
          </ul>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.settings { height: 100%; overflow: auto; padding: 12px 16px 24px; }
.sv-gate {
  font-size: 12px; color: var(--orange); border: 1px dashed var(--orange);
  border-radius: 8px; padding: 7px 10px; margin-bottom: 10px;
}
.sv-body {
  display: grid; gap: 14px; align-items: start;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
}
.sv-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.sv-card {
  background: var(--bg-glass); border: 1px solid var(--border);
  border-radius: 10px; padding: 12px;
}
.sv-card h3 { font-size: 13px; margin: 0 0 8px; font-weight: 600; }
.sv-card h3 em { font-style: normal; font-size: 10px; color: var(--text3); margin-left: 6px; font-weight: 400; }
.sv-sub { font-size: 11px; color: var(--text2); margin: 12px 0 6px; font-weight: 600; }
.sv-sub em { font-style: normal; font-weight: 400; color: var(--text3); margin-left: 6px; font-size: 10px; }
.sv-table { display: flex; flex-direction: column; gap: 4px; }
.sv-tr { display: grid; grid-template-columns: minmax(0,1fr) 74px 74px minmax(0,auto); gap: 6px; align-items: center; }
.sv-th { font-size: 10px; color: var(--text3); }
.sv-td { font-size: 11px; }
.sv-unit { font-size: 10px; color: var(--text3); }
.sv-in {
  font: inherit; font-size: 11px; padding: 3px 6px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg-glass); color: var(--text); min-width: 0;
}
.sv-in.wide { width: 100%; }
.sv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(178px, 1fr)); gap: 6px 10px; }
.sv-cell { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text2); }
.sv-cell.col { flex-direction: column; align-items: stretch; gap: 2px; }
.sv-cell span { font-size: 11px; }
.sv-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 6px; }
.sv-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.sv-primary {
  font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 14px; cursor: pointer;
  border: 1px solid var(--accent); background: var(--accent); color: #fff;
}
.sv-primary:disabled { opacity: .5; cursor: not-allowed; }
.sv-alt {
  font: inherit; font-size: 11px; padding: 3px 10px; border-radius: 12px; cursor: pointer;
  border: 1px solid var(--border); background: var(--bg-glass); color: var(--text2);
}
.sv-alt.armed { border-color: var(--red); color: var(--red); }
.sv-note { font-size: 10px; color: var(--text3); margin: 8px 0 0; }
.sv-nodes { display: flex; flex-wrap: wrap; gap: 6px; }
.sv-node {
  font: inherit; font-size: 11px; padding: 3px 9px; border-radius: 12px; cursor: pointer;
  border: 1px solid var(--border); background: var(--bg-glass); color: var(--text2);
  display: inline-flex; align-items: center; gap: 4px;
}
.sv-node.on { border-color: var(--accent); color: var(--accent); }
/* The two marks mean "this node has an override of some kind", which is the
   only way to see at a glance who has been tuned by hand. */
.sv-node i { font-style: normal; font-size: 9px; border: 1px dashed var(--text3); border-radius: 5px; padding: 0 3px; color: var(--text3); }
.sv-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 10px; color: var(--text3); margin: 8px 0 2px; }
.sv-meta code { font-size: 10px; }
.sv-suspect { color: var(--orange); }
.sv-muted { color: var(--orange); }
.sv-help ul { margin: 0; padding-left: 18px; font-size: 11px; color: var(--text2); line-height: 1.7; }
</style>
