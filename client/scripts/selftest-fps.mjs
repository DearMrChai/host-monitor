/**
 * selftest-fps.mjs — the degrade guard, tested without a slow GPU (S4 §1.4)
 *
 * "连续 30s < 20fps 就降级" is the one acceptance criterion here that cannot be
 * produced on demand: it needs a machine that is actually struggling. So the
 * guard takes its clock as an injection and this file drives fabricated frame
 * streams through it - a healthy 30fps, a struggling 12fps, a total stall, the
 * partial window that must not be judged yet, and the transient that must not
 * fire a one-way switch.
 *
 * Run: node client/scripts/selftest-fps.mjs   (exit 1 on failure)
 */
import { createFpsGuard, FPS_DEFAULTS } from '../src/lib/fps.js'

let pass = 0
const failures = []
const ok = (name) => { pass++; console.log(`PASS  ${name}`) }
const bad = (name, why) => { failures.push(name); console.log(`FAIL  ${name}\n      ${why}`) }

/** A clock the test turns by hand, plus the frame stream to feed it. */
function harness(rate, fromMs = 0) {
  let t = fromMs
  let fps = rate
  const guard = {}
  const now = () => t
  guard.make = (opts) => createFpsGuard({ now, ...opts })
  /** Advance `seconds`, ticking at the current rate (changeable mid-test). */
  guard.run = (seconds, tickFn) => {
    const step = 1000 / fps
    const end = t + seconds * 1000
    while (t < end) { t += step; tickFn?.(t) }
  }
  guard.setRate = (v) => { fps = v }
  guard.at = (ms) => { t = ms }
  guard.now = () => t
  return guard
}

/* 1. A healthy 30fps wall never degrades - the cap itself must not look like a
      fault, which is why the threshold has to sit under FPS_CAP, not at it. */
{
  const h = harness(30)
  let fired = null
  const g = h.make({ onDegrade: (i) => { fired = i } })
  for (let s = 0; s < 60; s++) { h.run(1, () => g.tick()); g.check() }
  if (!fired && !g.degraded()) ok(`30fps 持续 60s 不降级（实测 ${g.fps(h.now()).toFixed(1)}fps）`)
  else bad('30fps 不应降级', `degraded with ${fired?.fps?.toFixed(1)}fps`)
}

/* 2. 12fps over the window degrades, and says roughly the right number. */
{
  const h = harness(12)
  let fired = null
  const g = h.make({ onDegrade: (i) => { fired = i } })
  for (let s = 0; s < 40; s++) { h.run(1, () => g.tick()); g.check() }
  const good = fired && Math.abs(fired.fps - 12) < 1.5
  if (good) ok(`12fps 持续 40s → 降级并报 ${fired.fps.toFixed(1)}fps`)
  else bad('12fps 应触发降级', fired ? `reported ${fired.fps.toFixed(1)}fps` : 'never fired')
}

/* 3. The failure mode with no frames to notice it with: the renderer stopped
      altogether (context lost and never restored, GPU wedged). A tick-driven
      sampler would sit there forever; the timer is what catches this. */
{
  const h = harness(30)
  let fired = null
  const g = h.make({ onDegrade: (i) => { fired = i } })
  h.run(3, () => g.tick())          // three good frames, then silence
  for (let s = 3; s < 45; s++) { h.run(1); g.check() }
  if (fired) ok('彻底停帧 42s → 降级（不依赖有帧才判）')
  else bad('停帧必须降级', 'never fired with 0 frames')
}

/* 4. A partial window must not judge: 5s of 4fps is real but it is also what a
      shader compile or a page load looks like from the inside. */
{
  const h = harness(4)
  let fired = null
  const g = h.make({ onDegrade: (i) => { fired = i } })
  for (let s = 0; s < 8; s++) { h.run(1, () => g.tick()); g.check() }
  const early = !!fired
  for (let s = 8; s < 40; s++) { h.run(1, () => g.tick()); g.check() }
  if (early) bad('窗口未满时不得降级', `fired at ${h.now() / 1000}s`)
  else ok(`窗口未满（8s）不判：${FPS_DEFAULTS.minSpanMs / 1000}s 之后才降级=${!!fired}`)
  if (!fired) bad('慢帧最终必须降级', 'never fired once the window was full')
}

/* 5. One-way and once only: a wall that oscillates between two faces is worse
      than either, and the handler must not run per check after the fact. */
{
  const h = harness(10)
  let count = 0
  const g = h.make({ onDegrade: () => { count++ } })
  for (let s = 0; s < 60; s++) { h.run(1, () => g.tick()); g.check() }
  if (count === 1) ok('降级只触发一次（60s 慢帧）')
  else bad('降级必须一次性', `onDegrade ran ${count} times`)
}

/* 6. A transient must not cost the 3D forever. Because degradation is one-way,
      the rule has to be "the whole trailing window is bad", not "the mean over
      whatever has been sampled so far" - otherwise a 10s stall during the cold
      start (shader compile, another process grabbing the GPU) fires the wall and
      never lets it back. 10s at 5fps inside healthy traffic is that case. */
{
  const h = harness(30)
  const g = h.make({ onDegrade: () => {} })
  for (let s = 0; s < 20; s++) { h.run(1, () => g.tick()); g.check() }
  h.setRate(5)
  for (let s = 20; s < 30; s++) { h.run(1, () => g.tick()); g.check() }
  h.setRate(30)
  for (let s = 30; s < 70; s++) { h.run(1, () => g.tick()); g.check() }
  const after = g.fps(h.now())
  if (!g.degraded() && after > 25) ok(`10 秒瞬时掉帧（5fps）不降级，窗口均值已滑回 ${after.toFixed(1)}fps`)
  else bad('瞬时掉帧不得永久降级', `degraded=${g.degraded()} mean=${after.toFixed(1)}fps`)
}

console.log(`\n[selftest-fps] pass=${pass} fail=${failures.length}`)
process.exit(failures.length ? 1 : 0)
