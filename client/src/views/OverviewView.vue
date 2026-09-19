<script setup>
import { computed } from 'vue'
import HostCard from '../components/HostCard.vue'
import AlertPanel from '../components/AlertPanel.vue'
import { sortHostsForOverview, displayName, CLASS_LABELS } from '../lib/status.js'
import { admin, canWrite, openDialog, rosterPost, flash } from '../lib/admin.js'

/* V1 overview body. Cluster bar + alert banner live in the App shell
   since P3 (shared with the V1.5 topology view). */

const props = defineProps({
  hosts: { type: Array, default: () => [] },
  alerts: { type: Object, default: () => ({ active: [], resolved: [] }) },
  /* S1b: host_ids the roster auto-enrolled but nobody has classified yet. */
  newNodes: { type: Array, default: () => [] },
})
defineEmits(['open'])

const sorted = computed(() => sortHostsForOverview(props.hosts))

/* The guidance bar is the only place a first-seen node gets its class. It stays
   a single inline row per node — a modal for "is this yours forever?" is the
   kind of friction that ends with people never classifying anything. */
const byId = computed(() => new Map(props.hosts.map(h => [h.host_id, h])))
const pending = computed(() => props.newNodes
  .map(id => byId.value.get(id) || { host_id: id }))

async function classify(node, cls) {
  if (!canWrite()) {
    openDialog(
      admin.passphraseSet ? '需要管理口令才能确认节点归类' : '先设置管理口令，才能给节点定归类',
      () => classify(node, cls),
    )
    return
  }
  const r = await rosterPost(`/api/roster/${node.host_id}/class`, { cls })
  if (r.ok) flash(`${displayName(node)} → ${CLASS_LABELS[cls]}`)
}
</script>

<template>
  <div class="overview">
    <div v-if="pending.length" class="ov-guide">
      <span class="og-lead">新节点待确认 <em>归为"临时"后它失联只标离场、不再拉低在线率</em></span>
      <span class="og-item" v-for="n in pending" :key="n.host_id">
        <b :title="'host_id: ' + n.host_id">{{ displayName(n) }}</b>
        <i v-if="!byId.has(n.host_id)" class="og-away">不在场</i>
        <button @click="classify(n, 'persistent')">保持常驻</button>
        <button class="og-alt" @click="classify(n, 'ephemeral')">设为临时</button>
      </span>
    </div>
    <div class="ov-body">
      <main class="ov-grid">
        <div v-if="!sorted.length" class="ov-empty">
          <p>暂无节点。启动 Agent：python main.py --server ws://&lt;server&gt;:9100 --role &lt;角色&gt;</p>
        </div>
        <HostCard v-for="h in sorted" :key="h.host_id" :host="h"
                  @open="id => $emit('open', id)" />
      </main>
      <AlertPanel class="ov-alerts" :alerts="alerts" @open="id => $emit('open', id)" />
    </div>
  </div>
</template>

<style scoped>
.overview { height: 100%; display: flex; flex-direction: column; overflow: hidden; position: relative; }
/* First run after S1 lists every auto-enrolled node at once (the local dev DB
   seeds 8), so the bar must wrap and scroll rather than clip its own buttons. */
.ov-guide {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px;
  max-height: 88px; overflow-y: auto;
  margin: 14px 14px -4px; padding: 8px 12px;
  font-size: 12px; color: var(--text2);
  background: rgba(210,153,34,.08); border: 1px dashed var(--orange); border-radius: 8px;
}
.og-lead { flex-shrink: 0; font-weight: 600; color: #9a6700; }
.og-lead em { font-style: normal; font-weight: 400; font-size: 11px; color: var(--text3); margin-left: 6px; }
.og-item { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.og-item b { font-size: 12px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.og-away { font-style: normal; font-size: 10px; color: var(--text3); }
.og-item button {
  font: inherit; font-size: 11px; cursor: pointer; padding: 2px 9px;
  border-radius: 11px; border: 1px solid var(--accent); background: var(--accent); color: #fff;
}
.og-item button.og-alt { background: var(--bg-glass); color: var(--text2); border-color: var(--border); }
.og-item button:hover { filter: brightness(1.06); }
.ov-body {
  flex: 1; display: grid; grid-template-columns: 1fr 260px;
  gap: 14px; padding: 14px; overflow: auto;
}
.ov-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px; align-content: start;
}
.ov-empty {
  grid-column: 1 / -1; text-align: center; padding: 60px 20px;
  color: var(--text3); font-size: 13px;
}
.ov-alerts { position: sticky; top: 0; align-self: start; max-height: calc(100vh - 100px); overflow: auto; }
@media (max-width: 900px) {
  .ov-body { grid-template-columns: 1fr; }
}
</style>
