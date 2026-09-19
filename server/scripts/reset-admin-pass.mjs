/**
 * Reset the board's admin passphrase (S5 §3.3, closes the H13 half that is
 * fixable without an account system).
 *
 * Why a script and not an endpoint: a "forgot my passphrase" HTTP route is a
 * door into the thing that guards every other write. Forgetting it is handled
 * where the trust already is - on the machine that holds the file. Running this
 * needs filesystem access to `roster.db`, which is the same access needed to
 * read it, so it grants nothing an attacker did not already have.
 *
 * This is a RESET, not a recovery: the stored value is an scrypt hash, so the
 * old passphrase cannot be shown to anybody. After this runs, every write is
 * refused again (default-deny, S1 §5.2) until somebody sets a new one in the UI.
 *
 * Usage:  node scripts/reset-admin-pass.mjs --db <path-to-roster.db> --yes
 *         (without --yes it only reports the current state)
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const confirmed = argv.includes('--yes')
const dbPath = flag('db') || process.env.HM_ROSTER_DB || path.join(HERE, '..', 'data', 'roster.db')

if (!existsSync(dbPath)) {
  console.error(`NO-DB  找不到名册库：${dbPath}\n     用 --db <roster.db 路径> 指过去。`)
  process.exit(2)
}

let db
try {
  db = new DatabaseSync(dbPath)
} catch (err) {
  console.error(`OPEN-FAIL  ${err.message}`)
  console.error('           Server 正在写这个库时可能短暂占用；先停 Server 再试。')
  process.exit(2)
}

try {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'admin_pass'").get()
  const nodes = db.prepare('SELECT COUNT(*) c FROM nodes WHERE enroll_token IS NOT NULL').get().c
  if (!row) {
    console.log('IDLE  服务端本来就没有口令：所有写操作已经是默认拒绝，无需重置。')
    console.log('      在看板上做第一次写操作，它会引导你设置新口令。')
    process.exit(0)
  }
  console.log(`STATE 现有口令哈希：${String(row.value).split('$')[0]}（不可逆，本脚本不显示也无法显示原文）`)
  console.log(`STATE 已带节点密钥的节点：${nodes} 台（重置口令不影响它们的接入凭据）`)
  if (!confirmed) {
    console.log('DRY-RUN  未做任何修改。确认要重置请加 --yes。')
    console.log('         重置后：所有设备上的看板写操作立即变灰，需要重新设置并重新输入新口令。')
    process.exit(0)
  }
  db.prepare("DELETE FROM meta WHERE key = 'admin_pass'").run()
  console.log('DONE  口令已清除，写操作回到默认拒绝。')
  console.log('      下一步：在看板上任意一次写操作 → 按提示设置新口令（4 位以上）。')
  console.log('      提醒：如果这次是别人误改的，考虑把口令轮换记录写进交接说明。')
} catch (err) {
  console.error(`FAIL  ${err.message}`)
  process.exit(2)
} finally {
  db.close()
}
