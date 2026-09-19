<script setup>
import { computed } from 'vue'

/* One probe plan, edited in place (S6 §4/§5). The parent owns the object and
   decides which endpoint the result goes to — the global plan and a node's own
   plan have the same shape, and a second copy of this form is how the two drift
   apart. */

const props = defineProps({
  // A live plan object: { gateway, key_hosts, probe_interval_seconds, window_size, sites }.
  plan: { type: Object, required: true },
  // True when this view only holds masked targets: a form that submits
  // `192.168.*.*` would retarget the probes, so it is not a form at all.
  masked: { type: Boolean, default: false },
  // Node plans may leave the timing out and inherit the global one.
  inheritTiming: { type: Boolean, default: false },
})

const blank = (t) => !t || (!String(t.name ?? '').trim() && !String(t.host ?? '').trim()
  && (t.tcp_port === undefined || t.tcp_port === null || t.tcp_port === ''))

/* A row the operator never typed into is not a value to validate — dropping it
   is the difference between "add 关键主机" and a form that cannot be saved.
   A half-filled row still travels, so the server can refuse it by name. */
function prune() {
  if (Array.isArray(props.plan.key_hosts)) {
    props.plan.key_hosts = props.plan.key_hosts.filter(t => !blank(t))
  }
}

function addHost() {
  if (!Array.isArray(props.plan.key_hosts)) props.plan.key_hosts = []
  props.plan.key_hosts.push({ id: '', name: '', host: '', tcp_port: null })
}
function dropHost(i) { props.plan.key_hosts.splice(i, 1) }

function setGatewayNull() {
  props.plan.gateway = null
}
function ensureGateway() {
  if (!props.plan.gateway) props.plan.gateway = { name: '网关', host: '', tcp_port: null }
}

const gw = computed(() => props.plan.gateway || null)
const sites = computed(() => Object.keys(props.plan.sites || {}))

/* tcp_port arrives from the endpoint as a number or absent; the inputs need a
   string-ish model, so the write side normalises blank back to null (which the
   server reads as "ICMP only") instead of leaving `''` to become 0. */
function normPort(t) { if (t && (t.tcp_port === '' || t.tcp_port === undefined)) t.tcp_port = null }
</script>

<template>
  <div class="ppe">
    <div class="ppe-row ppe-gw">
      <span class="ppe-k">网关</span>
      <template v-if="gw">
        <input v-model.trim="gw.name" class="ppe-name" :disabled="masked" placeholder="名称" />
        <input v-model.trim="gw.host" class="ppe-host" :disabled="masked" spellcheck="false"
               placeholder="地址（IPv4 / 主机名）" />
        <input v-model="gw.tcp_port" class="ppe-port" :disabled="masked" placeholder="TCP 端口"
               @blur="normPort(gw)" />
        <button v-if="!masked" class="ppe-x" title="不探网关（只探 Server 与关键主机）"
                @click="setGatewayNull">清除</button>
      </template>
      <button v-else class="ppe-add" :disabled="masked" @click="ensureGateway">+ 添加网关</button>
    </div>

    <div class="ppe-row" v-for="(t, i) in plan.key_hosts || []" :key="i">
      <span class="ppe-k">关键主机</span>
      <input v-model.trim="t.id" class="ppe-id" :disabled="masked" placeholder="id（可选）" />
      <input v-model.trim="t.name" class="ppe-name" :disabled="masked" placeholder="名称" />
      <input v-model.trim="t.host" class="ppe-host" :disabled="masked" spellcheck="false"
             placeholder="地址" />
      <input v-model="t.tcp_port" class="ppe-port" :disabled="masked" placeholder="TCP 端口"
             @blur="normPort(t)" />
      <button v-if="!masked" class="ppe-x" @click="dropHost(i)">删除</button>
    </div>

    <div class="ppe-row">
      <span class="ppe-k" />
      <button class="ppe-add" :disabled="masked || (plan.key_hosts || []).length >= 8"
              :title="(plan.key_hosts || []).length >= 8 ? '上限 8 个：探测环预算有限（H3）' : ''"
              @click="addHost">+ 添加关键主机</button>
      <button v-if="!masked" class="ppe-add ghost" @click="prune">清掉空行</button>
    </div>

    <div class="ppe-row ppe-timing">
      <span class="ppe-k">节奏</span>
      <label>每 <input v-model="plan.probe_interval_seconds" class="ppe-num" :disabled="masked"
                      placeholder="—"> 秒一次</label>
      <label>窗口 <input v-model="plan.window_size" class="ppe-num" :disabled="masked"
                        placeholder="—"> 个点</label>
      <span class="ppe-hint" v-if="inheritTiming">留空即沿用全局</span>
    </div>

    <!-- Sites are plan *selection*, not this plan: an editor for them would have
         to answer "which node is at which site" in the same screen, and that is
         the node column to the right. This batch says what exists and stops. -->
    <div class="ppe-sites" v-if="sites.length">
      已配站点计划：<code v-for="s in sites" :key="s">{{ s }}</code>
      <span class="ppe-hint">（本页暂不编辑站点；节点归到哪个站点见右侧"档案"）</span>
    </div>

    <p class="ppe-masked" v-if="masked">
      地址是掩码形态（<code>*.*</code>），所以这一栏只读：带着掩码保存等于把探测目标改成一个不存在的地址。
      设置管理口令后可编辑。
    </p>
  </div>
</template>

<style scoped>
.ppe { display: flex; flex-direction: column; gap: 6px; }
.ppe-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ppe-k { font-size: 11px; color: var(--text2); min-width: 52px; }
.ppe input {
  font: inherit; font-size: 11px; padding: 3px 6px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg-glass); color: var(--text);
}
.ppe input:disabled { opacity: .7; }
.ppe-id { width: 90px; }
.ppe-name { width: 90px; }
.ppe-host { width: 150px; }
.ppe-port { width: 74px; }
.ppe-num { width: 52px; }
.ppe-timing label { font-size: 11px; color: var(--text2); display: inline-flex; align-items: center; gap: 4px; }
.ppe-add, .ppe-x {
  font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 10px; cursor: pointer;
  border: 1px dashed var(--border); background: none; color: var(--text2);
}
.ppe-x { border-style: solid; }
.ppe-add.ghost { opacity: .8; }
.ppe-hint { font-size: 10px; color: var(--text3); }
.ppe-sites { font-size: 11px; color: var(--text2); display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.ppe-sites code { font-size: 10px; padding: 0 5px; border: 1px solid var(--border); border-radius: 6px; }
.ppe-masked { font-size: 11px; color: var(--warn-ink); margin: 2px 0 0; }
</style>
