<script setup>
import { reactive, computed, ref, watch, nextTick } from 'vue'
import { admin, submitDialog, closeDialog } from '../lib/admin.js'

/* Admin passphrase dialog (S1 设计 §5.2). Three modes, one component:
   create (server has none) / enter (we forgot ours) / change (rotate it). */

const form = reactive({ pass: '', confirm: '', oldPass: '' })
const error = ref('')
const passEl = ref(null)
const busy = ref(false)

const mode = computed(() => admin.dialog?.mode || 'create')
const needsNew = computed(() => mode.value !== 'enter')
const title = computed(() => ({
  create: '设置管理口令', enter: '输入管理口令', change: '修改管理口令',
}[mode.value]))
const subtitle = computed(() => ({
  create: '还没有口令，所以看板上所有归类操作都是禁用的。设一次就好。',
  enter: '这台设备上没存口令。输入后本机操作即可生效（不会重新下发到服务器）。',
  change: '修改需要原口令。',
}[mode.value]))

watch(() => admin.dialog, async (d) => {
  if (!d) return
  form.pass = ''; form.confirm = ''; form.oldPass = ''; error.value = ''
  await nextTick()
  passEl.value?.focus()
})

async function submit() {
  if (busy.value) return
  if (needsNew.value && form.pass !== form.confirm) {
    error.value = '两次输入不一致'
    return
  }
  busy.value = true
  const r = await submitDialog({ pass: form.pass, oldPass: form.oldPass })
  busy.value = false
  if (!r.ok) error.value = r.error || '失败'
}
</script>

<template>
  <div v-if="admin.dialog" class="pd-mask" @click.self="closeDialog()">
    <form class="pd" @submit.prevent="submit()">
      <div class="pd-head">
        <b>{{ title }}</b>
        <button type="button" class="pd-x" @click="closeDialog()">×</button>
      </div>
      <p class="pd-sub">{{ subtitle }}</p>
      <p v-if="admin.dialog.reason" class="pd-reason">{{ admin.dialog.reason }}</p>

      <label v-if="mode === 'change'">
        原口令
        <input v-model="form.oldPass" type="password" autocomplete="off" placeholder="必填" />
      </label>
      <label>
        {{ mode === 'enter' ? '管理口令' : '新口令（至少 4 位）' }}
        <input v-model="form.pass" ref="passEl" type="password" autocomplete="off" />
      </label>
      <label v-if="needsNew">
        确认新口令
        <input v-model="form.confirm" type="password" autocomplete="off" />
      </label>

      <p v-if="error" class="pd-err">{{ error }}</p>
      <div class="pd-actions">
        <button type="button" class="ghost" @click="closeDialog()">取消</button>
        <button type="submit" :disabled="busy || !form.pass">{{ mode === 'enter' ? '记住并继续' : '保存' }}</button>
      </div>
      <p class="pd-note">
        说明：这是局域网内的明文 HTTP，口令不加密传输。它挡的是误操作和路过的人，
        不挡主动攻击者——真要对外，得先有 TLS 与账号体系（当前演示形态 A 不做）。
      </p>
    </form>
  </div>
</template>

<style scoped>
.pd-mask {
  position: fixed; inset: 0; z-index: 80; background: rgba(0,0,0,.28);
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.pd {
  width: 340px; max-width: 100%; background: var(--bg-glass);
  border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 8px;
  box-shadow: 0 12px 40px rgba(0,0,0,.18);
}
.pd-head { display: flex; align-items: center; justify-content: space-between; font-size: 14px; }
.pd-x { border: none; background: none; font-size: 18px; cursor: pointer; color: var(--text3); }
.pd-sub { margin: 0; font-size: 12px; color: var(--text2); line-height: 1.5; }
.pd-reason { margin: 0; font-size: 12px; color: var(--warn-ink); }
.pd label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text2); }
.pd input {
  font: inherit; font-size: 13px; padding: 6px 8px;
  border: 1px solid var(--border); border-radius: 7px; background: rgba(255,255,255,.6);
}
.pd-err { margin: 0; font-size: 12px; color: var(--crit-ink); }
.pd-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.pd-actions button {
  font: inherit; font-size: 12px; padding: 5px 14px; cursor: pointer;
  border-radius: 14px; border: 1px solid var(--accent); background: var(--accent); color: #fff;
}
.pd-actions button:disabled { opacity: .5; cursor: not-allowed; }
.pd-actions .ghost { background: none; color: var(--text2); border-color: var(--border); }
.pd-note {
  margin: 2px 0 0; font-size: 11px; line-height: 1.5; color: var(--text3);
  border-top: 1px dashed var(--border); padding-top: 7px;
}
</style>
