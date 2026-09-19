<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import EventStream from '../components/EventStream.vue'
import { displayName } from '../lib/status.js'
import { admin, canWrite, openDialog, rosterPost, flash } from '../lib/admin.js'

/* S2c 接入页 (design §6): the four blocks the design asked for — mint a code,
   copy a command, watch the machine arrive, read who got turned away — plus the
   demo-fleet switch, because "演示可关" is a red line and a switch nobody can
   find is the same as no switch.

   Two rules shaped this file:
   - The plaintext code is shown exactly once (the mint response). Everything
     after that works off `code_tail` + `id`, so a refresh cannot leak a live
     credential through this page, and revoking still works.
   - Every number on this page is the server's. `keyless_agents`, `demo.enabled`
     and the ingest mode come from the snapshot (admin.js), not from a guess. */

const props = defineProps({
  hosts: { type: Array, default: () => [] },
})
defineEmits(['open'])

const now = ref(Date.now())
const codes = ref([])
const rosterNodes = ref([])   // name source for nodes the live host table lacks
const counts = ref({})
const loading = ref(false)
const minted = ref(null)        // { code, code_tail, expires_at, max_uses, host, agent_port }
const targetHost = ref('')
const ttlMin = ref(15)
const maxUses = ref(1)
const seenPaired = new Set()    // "codeId:host_id" we have already announced
const justJoined = ref([])      // host_ids that paired since the last poll

let pollTimer = null
let tickTimer = null

const MODE_TEXT = {
  off: '接入凭据校验已关闭（HM_INGEST_TOKEN=off）：任何机器都能上报，仅供排障时临时使用',
  legacy: '当前档位 legacy：陌生机器必须配对，已入册的老 Agent 仍可无密钥上报（下方点名）',
  strict: '当前档位 strict：每一台机器都要凭据，缺密钥即拒',
}

async function load() {
  loading.value = true
  try {
    const res = await fetch('/api/enroll')
    if (res.ok) {
      const data = await res.json()
      codes.value = data.codes || []
      counts.value = data.ingest?.counts || {}
      // A code whose paired_ids grew is the "it arrived" moment the page exists
      // for. Seeding on the first pass keeps a reload from celebrating old joins.
      const first = !load.seeded
      for (const c of codes.value) {
        for (const id of c.paired_ids || []) {
          const key = `${c.id}:${id}`
          if (!seenPaired.has(key)) {
            seenPaired.add(key)
            if (!first && !justJoined.value.includes(id)) justJoined.value.push(id)
          }
        }
      }
      load.seeded = true
    }
  } catch { /* server unreachable: the next snapshot says it louder */ }
  /* Names for machines the live host table does not carry. Both lists on this
     page (刚配好的那台、未带凭据的那几台) are roster facts, and after a Server
     restart a keyless v1 Agent is in the roster but not in `hosts` - showing
     `legacy-box` where the board elsewhere says 客厅小主机 reads as a bug.
     Separate request, own guard: it must not be able to blank the code list. */
  try {
    const rs = await fetch('/api/roster')
    if (rs.ok) rosterNodes.value = (await rs.json()).nodes || []
  } catch { /* names fall back to host_id this round */ }
  loading.value = false
}

onMounted(() => {
  load()
  pollTimer = setInterval(load, 3000)
  tickTimer = setInterval(() => { now.value = Date.now() }, 1000)
})
onBeforeUnmount(() => {
  clearInterval(pollTimer)
  clearInterval(tickTimer)
})

/* ---------- mint ---------- */

async function mint() {
  if (!canWrite()) {
    openDialog(admin.passphraseSet ? '需要管理口令才能签发配对码' : '先设置管理口令，才能签发配对码', mint)
    return
  }
  const r = await rosterPost('/api/admin/enroll',
    { ttl_minutes: Number(ttlMin.value), max_uses: maxUses.value === 0 ? null : Number(maxUses.value) })
  if (!r.ok) return
  const j = r.json || {}
  minted.value = {
    code: j.code, expires_at: j.expires_at, max_uses: j.max_uses,
    host: j.host || location.hostname, agent_port: j.agent_port || 9100,
  }
  // The address this page was opened on is the right default only when the
  // Agent is on the same box. From another machine, 127.0.0.1 points at itself.
  targetHost.value = minted.value.host
  justJoined.value = []
  load()
  flash('配对码已生成：明文只显示这一次')
}

async function revoke(c) {
  const r = await rosterPost('/api/admin/enroll/revoke', { id: c.id })
  if (r.ok) {
    flash(`已撤销配对码 …${c.code_tail}`)
    if (minted.value && minted.value.code.slice(-4) === c.code_tail) minted.value = null
    load()
  }
}

/* ---------- commands ---------- */

const isLocalhost = computed(() => /^(127\.|\[::1\]|localhost)/i.test(targetHost.value || ''))
const cmdWin = computed(() => `python main.py --server ws://${targetHost.value || '<服务器地址>'}:${minted.value?.agent_port || 9100}`
  + (minted.value ? ` --enroll ${minted.value.code}` : ''))
const cmdLinux = computed(() => `python3 main.py --server ws://${targetHost.value || '<服务器地址>'}:${minted.value?.agent_port || 9100}`
  + (minted.value ? ` --enroll ${minted.value.code}` : ''))

/** Clipboard without assuming a secure context: the panel is served over plain
 *  http on the LAN, where navigator.clipboard does not exist off localhost. */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      flash('已复制到剪贴板')
      return
    }
  } catch { /* fall through to the selection path */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const okd = document.execCommand('copy')
    document.body.removeChild(ta)
    flash(okd ? '已复制到剪贴板' : '浏览器拒绝了复制：请手动选中这行文本', okd ? 'ok' : 'err')
  } catch {
    flash('浏览器拒绝了复制：请手动选中这行文本', 'err')
  }
}

/* ---------- display helpers ---------- */

function left(ts) {
  const ms = (ts || 0) - now.value
  if (ms <= 0) return '已过期'
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return (h ? `${h} 小时 ` : '') + `${m} 分 ${String(s % 60).padStart(2, '0')} 秒`
}
const liveCodes = computed(() => codes.value.filter(c => c.expires_at > now.value))
const byId = computed(() => new Map(props.hosts.map(h => [h.host_id, h])))
/* Live host first, roster row second, bare id last. The two server sources agree
   on the name; the roster only matters when the live host table lacks the node. */
const byRosterId = computed(() => new Map(rosterNodes.value.map(n => [n.host_id, n])))
function nodeText(id) {
  const h = byId.value.get(id) || byRosterId.value.get(id)
  return h ? displayName(h) : id
}

/* ---------- demo fleet ---------- */

async function setDemo(on) {
  if (!canWrite()) {
    openDialog(admin.passphraseSet ? '需要管理口令才能开关演示机群' : '先设置管理口令，才能开关演示机群',
      () => setDemo(on))
    return
  }
  const r = await rosterPost('/api/admin/demo', { enabled: on })
  if (r.ok) flash(on ? '演示机群已开启（4 台，显示名带"模拟-"前缀）' : '演示机群已关闭：生成停止、节点退役', 'ok')
}

const demoOn = computed(() => admin.demo.enabled)
const keyless = computed(() => admin.keylessAgents || [])
</script>

<template>
  <div class="enroll">
    <div v-if="admin.ingestMode !== 'strict'" class="en-mode" :class="admin.ingestMode">
      {{ MODE_TEXT[admin.ingestMode] || MODE_TEXT.legacy }}
    </div>

    <div class="en-body">
      <main class="en-col">
        <!-- 1. pairing code -->
        <section class="en-card">
          <h3>配对码 <em>一次性的码换一枚长期节点密钥，密钥由 Agent 自己存</em></h3>
          <div v-if="!minted" class="en-mint">
            <label>有效期
              <select v-model.number="ttlMin">
                <option :value="15">15 分钟</option>
                <option :value="60">1 小时</option>
                <option :value="1440">24 小时</option>
              </select>
            </label>
            <label>可用次数
              <select v-model.number="maxUses">
                <option :value="1">1 次</option>
                <option :value="3">3 次</option>
                <option :value="0">不限</option>
              </select>
            </label>
            <button class="en-primary" @click="mint">生成配对码</button>
          </div>
          <div v-else class="en-code">
            <code class="ec-text">{{ minted.code }}</code>
            <div class="ec-meta">
              <span>剩余 {{ left(minted.expires_at) }}</span>
              <span v-if="minted.max_uses">上限 {{ minted.max_uses }} 次</span>
              <button @click="copyText(minted.code)">复制码</button>
              <button class="en-alt" @click="minted = null">我记下了</button>
            </div>
            <p class="ec-note">明文只显示这一次；刷新页面后只能在下方列表里按尾号撤销它。</p>
          </div>

          <div v-if="liveCodes.length" class="en-codelist">
            <div class="cl-head">当前有效的配对码</div>
            <div class="cl-row" v-for="c in liveCodes" :key="c.id">
              <code>…{{ c.code_tail }}</code>
              <span class="cl-note" v-if="c.note">{{ c.note }}</span>
              <span>{{ c.max_uses ? `${c.uses}/${c.max_uses} 次` : `${c.uses} 次（不限）` }}</span>
              <span>{{ left(c.expires_at) }}</span>
              <span class="cl-ok" v-if="c.paired_ids.length">已接入 {{ c.paired_ids.length }}</span>
              <button class="en-x" title="撤销" @click="revoke(c)">撤销</button>
            </div>
          </div>
        </section>

        <!-- 2. the command, editable because localhost is rarely right -->
        <section class="en-card">
          <h3>在新机器上运行 <em>Agent 目录里执行；参数也可写进 agent.json</em></h3>
          <label class="en-host">Server 地址
            <input v-model.trim="targetHost" placeholder="192.168.x.x 或 ZeroTier 地址" spellcheck="false">
          </label>
          <p v-if="isLocalhost" class="ec-note">127/localhost 只适用于 Agent 与 Server 同一台机器；给朋友的那台要填他能看到这台 Server 的地址。</p>
          <div class="en-cmd">
            <span class="ec-os">Windows</span>
            <code>{{ cmdWin }}</code>
            <button @click="copyText(cmdWin)">复制</button>
          </div>
          <div class="en-cmd">
            <span class="ec-os">Linux</span>
            <code>{{ cmdLinux }}</code>
            <button @click="copyText(cmdLinux)">复制</button>
          </div>
        </section>

        <!-- 3. waiting for it to appear -->
        <section class="en-card">
          <h3>等待接入 <em>{{ loading ? '查询中…' : '每 3 秒查一次配对结果' }}</em></h3>
          <div v-if="!justJoined.length" class="en-wait">
            <span class="dot" />{{ minted ? '这台机器还没上来——检查它是否填对了 Server 地址' : '生成配对码后，新机器会在这里出现' }}
          </div>
          <div v-else class="en-joined">
            <span>已接入：</span>
            <button class="ej" v-for="id in justJoined" :key="id"
                    :title="'host_id: ' + id" @click="$emit('open', id)">
              {{ nodeText(id) }}<i>查看详情 →</i>
            </button>
          </div>
          <p class="ec-note" v-if="admin.ingestMode === 'legacy' && keyless.length">
            未带凭据的老 Agent 也算"接入成功"，所以它们不会出现在这里——见右侧点名。
          </p>
        </section>
      </main>

      <aside class="en-col">
        <!-- 4. who got turned away. S3b moved this off the in-memory ring (H15):
             the ledger is the durable stream, so a Server restart no longer erases
             the evidence that someone was knocking. The ring's counters stay, but
             labelled as per-boot, because that is all they ever were. -->
        <section class="en-card">
          <EventStream lock-kind="ingest" :max-rows="16" compact
                       title="异常接入与配对（近 24 小时）" />
          <div class="ev-counts" v-if="counts.denied || counts.paired">
            本次启动累计：拒绝 {{ counts.denied || 0 }} 次 · 配对 {{ counts.paired || 0 }} 次
            · 宽限放行 {{ counts.accepted_legacy || 0 }} 次
          </div>
        </section>

        <!-- keyless Agents: the honest cost of the default tier -->
        <section class="en-card" v-if="keyless.length">
          <h3>未带凭据的 Agent <em>{{ keyless.length }} 台</em></h3>
          <p class="ec-note">它们在 <code>legacy</code> 档下被放行，因为早于凭据层就上线了。按部署说明"里程碑重部署清单"逐台配对后，这个数字应归零，然后才翻 <code>strict</code>。</p>
          <div class="kl-row">
            <button class="kl" v-for="id in keyless" :key="id" :title="'host_id: ' + id"
                    @click="$emit('open', id)">{{ nodeText(id) }}<i>→</i></button>
          </div>
        </section>

        <!-- demo fleet switch (red line: the demo must be turn-off-able) -->
        <section class="en-card">
          <h3>演示机群 <em>4 台写死的道具，显示名带"模拟-"</em></h3>
          <div class="en-demo">
            <button class="en-primary" v-if="!demoOn" @click="setDemo(true)">开启演示机群</button>
            <button class="en-stop" v-else @click="setDemo(false)">关闭演示机群</button>
            <span class="dm-state" v-if="demoOn">运行中 · {{ admin.demo.count }} 台</span>
            <span class="dm-state off" v-else>已关闭</span>
          </div>
          <p class="ec-note">道具照常进告警面板，但<b>不</b>计入集群健康度、在线分母与聚合负载。关掉是真的关：生成停止、节点退役、其告警以"已退役"闭合。</p>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.enroll { height: 100%; overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.en-mode {
  font-size: 12px; padding: 7px 12px; border-radius: 8px;
  border: 1px solid var(--orange); color: var(--warn-ink); background: rgba(210,153,34,.08);
}
.en-mode.off { border-color: var(--red); color: var(--crit-ink); background: rgba(248,81,73,.08); }
.en-body { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 14px; align-items: start; }
.en-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.en-card {
  background: var(--bg-glass); border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 14px;
}
.en-card h3 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
.en-card h3 em { font-style: normal; font-weight: 400; font-size: 11px; color: var(--text3); margin-left: 6px; }
/* The durable ledger is the card's only content, so it drops its own frame here
   (same reason as the HUD variant): a box inside a box reads as two features. */
.en-card .event-stream { border: none; background: none; padding: 0; }
.en-mint { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--text2); }
.en-mint select {
  font: inherit; font-size: 12px; margin-left: 4px; padding: 3px 6px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg-glass); color: var(--text);
}
.en-primary {
  font: inherit; font-size: 12px; cursor: pointer; padding: 5px 14px; border-radius: 14px;
  border: 1px solid var(--accent); background: var(--accent); color: #fff;
}
.en-primary:hover, .ej:hover, button:hover { filter: brightness(1.06); }
button { font: inherit; }
.en-alt {
  font-size: 11px; cursor: pointer; padding: 3px 10px; border-radius: 12px;
  border: 1px solid var(--border); background: var(--bg-glass); color: var(--text2);
}
.en-code { display: flex; flex-direction: column; gap: 8px; }
.ec-text {
  font-family: ui-monospace, Consolas, monospace; font-size: 22px; letter-spacing: 2px;
  padding: 8px 10px; border-radius: 8px; border: 1px dashed var(--accent);
  background: rgba(9,105,218,.06); user-select: all;
}
.ec-meta { display: flex; align-items: center; gap: 12px; font-size: 11px; color: var(--text2); flex-wrap: wrap; }
.ec-meta button {
  font-size: 11px; cursor: pointer; padding: 3px 10px; border-radius: 12px;
  border: 1px solid var(--border); background: var(--bg-glass); color: var(--text2);
}
.ec-note { margin: 0; font-size: 11px; color: var(--text3); }
.en-codelist { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 8px; }
.cl-head { font-size: 11px; color: var(--text3); margin-bottom: 4px; }
.cl-row {
  display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--text2);
  padding: 3px 0; flex-wrap: wrap;
}
.cl-row code { font-family: ui-monospace, Consolas, monospace; color: var(--text); }
.cl-note { color: var(--text3); }
.cl-ok { color: var(--ok-ink); }
.en-x {
  margin-left: auto; font-size: 11px; cursor: pointer; padding: 2px 9px; border-radius: 11px;
  border: 1px solid var(--border); background: var(--bg-glass); color: var(--text2);
}
.en-host { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text2); margin-bottom: 8px; }
.en-host input {
  font: inherit; font-size: 12px; flex: 1; min-width: 0; padding: 4px 8px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg-glass); color: var(--text);
}
.en-cmd { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.ec-os { font-size: 10px; color: var(--text3); width: 52px; flex-shrink: 0; }
.en-cmd code {
  flex: 1; min-width: 0; font-family: ui-monospace, Consolas, monospace; font-size: 11px;
  padding: 5px 8px; border-radius: 6px; background: rgba(0,0,0,.04); border: 1px solid var(--border);
  overflow-x: auto; white-space: nowrap; user-select: all;
}
.en-cmd button {
  font-size: 11px; cursor: pointer; padding: 3px 10px; border-radius: 12px; flex-shrink: 0;
  border: 1px solid var(--border); background: var(--bg-glass); color: var(--text2);
}
.en-wait { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text3); }
.en-wait .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: pulse 1.6s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
.en-joined { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.ej {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px;
  padding: 4px 10px; border-radius: 14px; border: 1px solid var(--green); background: rgba(30,140,50,.08);
  color: var(--ok-ink);
}
.ej i { font-style: normal; font-size: 10px; color: var(--text3); }
.en-empty { font-size: 12px; color: var(--text3); }
.ev-counts { margin-top: 8px; font-size: 11px; color: var(--text3); }
.kl-row { display: flex; flex-wrap: wrap; gap: 6px; }
.kl {
  display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
  font-size: 11px; padding: 2px 9px; border-radius: 10px;
  border: 1px dashed var(--orange); color: var(--warn-ink); background: rgba(210,153,34,.06);
}
.kl i { font-style: normal; font-size: 10px; color: var(--text3); }
.en-demo { display: flex; align-items: center; gap: 10px; }
.en-stop {
  font-size: 12px; cursor: pointer; padding: 5px 14px; border-radius: 14px;
  border: 1px solid var(--red); background: rgba(248,81,73,.08); color: var(--crit-ink);
}
.dm-state { font-size: 11px; color: var(--ok-ink); }
.dm-state.off { color: var(--text3); }
.en-card p b { color: var(--text2); }
@media (max-width: 900px) {
  .en-body { grid-template-columns: 1fr; }
}
</style>
