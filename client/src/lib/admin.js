/**
 * Roster writes + the admin passphrase (S1b).
 *
 * Single outlet on purpose: where the passphrase lives and what a 403 means
 * must not be re-decided in the card menu, the guidance bar and the dialog.
 *
 * Threat model (S1 设计 §5.2, 诚实版): this stops mis-clicks and passers-by.
 * It is NOT protection against a determined attacker — the LAN is plaintext and
 * there is no TLS. That is accepted for demo form A (no public exposure).
 */
import { reactive } from 'vue'

const KEY = 'hm.admin.pass'

const readStored = () => {
  try { return localStorage.getItem(KEY) || '' } catch { return '' }
}

export const admin = reactive({
  passphraseSet: false,   // server truth, from the snapshot's `admin` field
  stored: readStored(),   // ours, localStorage: survives reloads, never synced
  dialog: null,           // null | { mode: 'create' | 'enter' | 'change', reason, retry }
  flash: null,            // { text, kind } — 3s toast for write results
  /* S2c: the ingest-credential state is a server fact, and the pairing page is
     the wrong place to re-derive it from a request. It already arrives with
     every snapshot, so the top bar and the page cannot disagree. */
  ingestMode: 'legacy',
  keylessAgents: [],
  demo: { enabled: false, count: 0 },
})

/** Called by App.vue on every snapshot so the UI knows writes are even possible. */
export function syncAdmin(snapshot) {
  const a = snapshot?.admin
  if (!a) return
  admin.passphraseSet = !!a.passphrase_set
  // GET /api/hosts only carries passphrase_set, so each field is guarded rather
  // than assumed - a missing key must not look like "mode: undefined".
  if (a.ingest_mode) admin.ingestMode = a.ingest_mode
  if (Array.isArray(a.keyless_agents)) admin.keylessAgents = a.keyless_agents
  if (a.demo) admin.demo = { enabled: !!a.demo.enabled, count: Number(a.demo.count) || 0 }
}

export const canWrite = () => admin.passphraseSet && !!admin.stored

let flashTimer = null
export function flash(text, kind = 'ok') {
  admin.flash = { text, kind }
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => { admin.flash = null }, 3_200)
}

/**
 * Open the passphrase dialog. `retry` is re-run after a successful set/entry,
 * so the user's click is not lost — the dialog is an interruption, not a form.
 */
export function openDialog(reason, retry = null) {
  const mode = !admin.passphraseSet ? 'create' : admin.stored ? 'change' : 'enter'
  admin.dialog = { mode, reason, retry }
}

function remember(pass) {
  admin.stored = pass || ''
  try {
    if (pass) localStorage.setItem(KEY, pass)
    else localStorage.removeItem(KEY)
  } catch { /* private mode: keep it in memory only */ }
}

/* Two devices (laptop + phone) can hold the same roster, so "the passphrase
   changed under this tab" is a real case, not a theoretical one. The first 403
   is answered by asking. If what the user then types is rejected too, opening
   the dialog again would be a loop with no exit - so the replay of a denied
   write reports the problem instead of re-asking. `replayPending` marks exactly
   that one automatic follow-up, never a fresh click. */
let replayPending = false

/**
 * The one roster write path. Returns { ok } and never throws, so callers can
 * keep their menus simple. A 403 opens the dialog instead of failing silently.
 */
export async function rosterPost(path, body, retry) {
  const isReplay = replayPending
  replayPending = false
  const headers = { 'content-type': 'application/json' }
  if (admin.stored) headers['x-hm-admin'] = admin.stored
  let res
  try {
    res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch {
    flash('服务器不可达，未做任何修改', 'err')
    return { ok: false }
  }
  const json = await res.json().catch(() => ({}))
  if (res.status === 403) {
    // Server-side truth changed (or we never had the key) — drop ours and ask.
    if (admin.stored) remember('')
    if (isReplay) {
      flash('口令未被接受：可能已在别处更换，需要到服务端重置', 'err')
      return { ok: false, denied: true }
    }
    openDialog(json.error || '需要管理口令', retry || (() => rosterPost(path, body)))
    return { ok: false, denied: true }
  }
  if (!res.ok) {
    /* A rejected config write carries `errors: [人话…]` next to `error` (S6 §2:
       validation refuses, it does not correct). One line per reason beats a
       toast that says "不符合约束" while hiding which of the twelve fields is
       wrong — and the caller still gets `errors` if it wants to mark rows. */
    const errs = Array.isArray(json.errors) ? json.errors.filter(Boolean) : []
    flash(errs.length ? `${json.error || '操作失败'}：${errs.join('；')}`
                      : (json.error || `操作失败（HTTP ${res.status}）`), 'err')
    return { ok: false, errors: errs }
  }
  return { ok: true, json }
}

/**
 * The one gated *read* path (S6 §5: /api/admin/config). It exists so the
 * passphrase does not acquire a second home the moment a page needs unmasked
 * values — a settings form that read the open endpoint would be looking at
 * `192.168.*.*`, and saving that back would retarget the probes.
 *
 * Unlike rosterPost this does not open the dialog on its own: a page can cope
 * with "no unmasked view this round" by falling back to the read-only one,
 * which is a better outcome than an interrupt over a GET.
 */
export async function adminGet(path) {
  const headers = {}
  if (admin.stored) headers['x-hm-admin'] = admin.stored
  let res
  try {
    res = await fetch(path, { headers })
  } catch {
    return { ok: false, error: '服务器不可达' }
  }
  const text = await res.text()
  if (res.status === 403) {
    if (admin.stored) remember('')
    return { ok: false, denied: true }
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  try { return { ok: true, json: JSON.parse(text) } } catch { return { ok: false, error: '响应不是 JSON' } }
}

/**
 * Dialog submit.
 *  - 'create': server has no passphrase -> set one, remember it, replay action
 *  - 'enter' : server has one, we forgot it -> remember and replay; the replay
 *              itself validates it (no fake "verify" endpoint needed)
 *  - 'change': set a new one, requires the old one server-side (design §5.2)
 */
export async function submitDialog({ pass, oldPass }) {
  const mode = admin.dialog?.mode
  if (mode === 'enter') {
    remember(pass)
    const retry = admin.dialog.retry
    admin.dialog = null
    flash('口令已记住')
    if (retry) await runRetry(retry)
    return { ok: true }
  }
  if ((pass || '').length < 4) return { ok: false, error: '口令至少 4 位' }
  const body = mode === 'change' ? { passphrase: pass, old: oldPass } : { passphrase: pass }
  let res
  try {
    res = await fetch('/api/admin/passphrase', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, error: '服务器不可达' }
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, error: json.error || '设置失败' }
  admin.passphraseSet = true
  remember(pass)
  const retry = admin.dialog.retry
  admin.dialog = null
  flash(mode === 'change' ? '管理口令已更新' : '管理口令已设置，现在可以操作节点了')
  if (retry) await runRetry(retry)
  return { ok: true }
}

/** Mark the automatic follow-up write, so a 403 inside it reports instead of
 *  reopening the dialog (see replayPending). */
async function runRetry(retry) {
  replayPending = true
  try { await retry() } finally { replayPending = false }
}

export function closeDialog() {
  admin.dialog = null
}
