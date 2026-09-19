/**
 * S6 self-test (H14 / J7): which alerts deserve to be *heard*.
 *
 * The decision lives in `src/lib/status.js` rather than inline in App.vue for
 * exactly one reason: it can then be asserted here instead of by someone sitting
 * and listening for forty seconds. The tones themselves stay a human check -
 * what must not regress is a row that the Server has marked as "no data behind
 * this any more" driving the crit loop, and a cancellation printing 已恢复.
 *
 * Usage: node scripts/selftest-sound.mjs
 */
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  critLoopWanted, isFrozen, resolvedText, FROZEN_TAG, FROZEN_HINT,
} from '../src/lib/status.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) pass += 1
  else fail += 1
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `   ${extra}` : ''}`)
}

const live = (level, i) => ({ id: `h${i}|m|agent`, host_id: `h${i}`, level })
const frozen = (level, i) => ({ ...live(level, i), frozen: true, frozen_since: Date.now() })

/* ---------- the loop ---------- */
ok('S1 只有冻结行的 CRIT/OFFLINE 不启动循环（重启后自己响一阵的那条路）',
  critLoopWanted([frozen('CRIT', 1), frozen('OFFLINE', 2)]) === false)
ok('S2 有活数据支撑的 CRIT 照常循环（降级不等于消音）',
  critLoopWanted([live('CRIT', 1)]) === true && critLoopWanted([live('OFFLINE', 2)]) === true)
ok('S3 冻结的一条不许把旁边活着的那条一起消音（这是最容易做错的方向）',
  critLoopWanted([frozen('CRIT', 1), live('OFFLINE', 2)]) === true)
ok('S4 空表与只有 WARN 的表都不响（WARN 本来就是一次性，不是循环）',
  critLoopWanted([]) === false && critLoopWanted([live('WARN', 1)]) === false
  && critLoopWanted(undefined) === false)
ok('S5 冻结是行的属性而不是机的属性：同一条解冻后立刻重新有声（Agent 回连即恢复报警）',
  (() => {
    const a = frozen('CRIT', 9)
    if (critLoopWanted([a]) !== false) return false
    delete a.frozen
    return isFrozen(a) === false && critLoopWanted([a]) === true
  })())

/* ---------- the one-shot ---------- */
ok('S6 一次性提示音走同一个判断（只压循环、不压单响，等于响一下还是吵）',
  isFrozen(frozen('CRIT', 1)) === true && isFrozen(live('CRIT', 1)) === false
  && isFrozen(undefined) === false)

/* ---------- J7 的后半：措辞不许把"没数据"说成"恢复了" ---------- */
ok('S7 四种非恢复的闭合方式都不印"已恢复"，且说的是它自己的成因（S1b/H14）',
  ['stale', 'retired', 'absent', 'reclassified'].every(
    (by) => resolvedText({ cancelled: by, state: 'resolved' }) !== '已恢复')
  && resolvedText({ cancelled: 'stale' }).includes('未上报')
  && resolvedText({ state: 'active' }) === '已恢复')
ok('S8 冻结标记的文案本身不含"已恢复"，且提示语说清了"不响 + 到期自行失效"',
  !!FROZEN_TAG && !FROZEN_TAG.includes('已恢复')
  && FROZEN_HINT.includes('不鸣响') && FROZEN_HINT.includes('失效'))

/* ---------- 接线：判断只有一处实现 ---------- */
const app = readFileSync(path.join(HERE, '..', 'src', 'App.vue'), 'utf8')
ok('S9 App.vue 用的是这个判断，而不是在调用点重抄一遍级别比较（H14 只改一处的风险）',
  app.includes('setCritLoop(critLoopWanted(') && !!app.match(/if \(isNew && !isFrozen\(a\)\)/)
  && !/a\.level === 'CRIT' \|\| a\.level === 'OFFLINE'/.test(app.split('function handleSounds')[1] || ''),
  'loop+one-shot 同源')

console.log(`\n[selftest-sound] pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
