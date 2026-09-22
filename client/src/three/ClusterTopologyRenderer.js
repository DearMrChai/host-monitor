import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { STATE, NEUTRAL, GROUND, LIGHTING, toRGB } from '../lib/palette.js'
import { SHELF, silhouetteSize, silhouetteTierOf, shelfGrid } from '../lib/silhouette.js'

/**
 * ClusterTopologyRenderer (V3 包 1 / 陈列架 A0)
 * =============================================
 * The fleet as 一排机位 on a shelf: one slot per host, each host drawn at its
 * own real proportions from `lib/silhouette.js` (三档卧式剪影: 薄板 / 方盒 / 超宽).
 *
 * What this scene no longer draws, and why (任务书 B §1.3, 裁定 §5.3-2): the hub
 * block, the gateway block, the probe-target stubs, the edges and the pulse dots
 * on them are gone. 链路 was a second reading on the same wall and it never
 * carried a decision (M6 注销); the link detail lives one click deeper, in A1.
 * The `linkLevel` / `links` fields of the view-model stay untouched - the 详情页
 * still reads them, so the withdrawal is a rendering decision, not a contract edit.
 *
 * One host = 站姿 + 高宽比 + 大小 (身份) + 面色 (状态) + 亮度 (负载). Nothing else:
 * 挂耳/格栅/灯点/logo 不当识别特征 (§7.2), 发光与描边不承载身份 (§5.3-甲档).
 */

/* S4 §1.2: state and ground colours come from lib/palette.js, because the DOM's
   `:root` is unreachable inside a canvas and a second hand-tuned copy of
   "what red is" is how the two faces of one fact start disagreeing. */
const LC = {
  OK: toRGB(STATE.OK),
  WARN: toRGB(STATE.WARN),
  CRIT: toRGB(STATE.CRIT),
  OFFLINE: toRGB(STATE.OFFLINE),
}
const GRAY = toRGB(NEUTRAL.noData)
/* Presentation-only: an ephemeral node that left. Lighter than OFFLINE because
   it carries no alarm (S1 §3.2 — deliberately not a fifth status level). */
const ABSENT = toRGB(NEUTRAL.absent)

export class ClusterTopologyRenderer {
  /**
   * opts.interactive - OrbitControls + click picking (off in kiosk: a wall nobody
   *   touches must not be able to end up rotated into an unreadable angle, and
   *   skipping the control saves a per-frame damping update - S4 §0).
   * opts.fpsCap - frames per second ceiling, 0 = every display refresh. A status
   *   wall is not a game; halving the render rate on a GT 1030 is the cheapest
   *   headroom the whole app has (S4 §1.4).
   */
  constructor(container, opts = {}) {
    const { interactive = true, fpsCap = 0 } = opts
    this.container = container
    this.interactive = interactive
    this.fpsCap = fpsCap
    this.nodes = new Map()   // host_id -> { group, body, base, bodyMat, baseMat, label, labelEl, tier }
    this._framedOnce = false // 交互页只在第一次推送时取景，之后不跟操作者的轨道抢镜头
    this._clock = new THREE.Clock()
    this._downPt = null
    this._visible = true
    this._contextLost = false
    this._acc = 0          // fpsCap accumulator
    this.onNodeClick = null  // (hostId) => void
    this.onFrame = null      // () => void - the kiosk's fps sampler lives here
    this.onContextLost = null     // () => void
    this.onContextRestored = null // () => void

    this._initRenderer()
    this._initScene()

    this._animate = this._animate.bind(this)
    this._raf = requestAnimationFrame(this._animate)
  }

  /* ---------- scaffolding ---------- */

  _initRenderer() {
    const w = this.container.clientWidth || 800
    const h = this.container.clientHeight || 600
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.renderer.setSize(w, h)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.container.appendChild(this.renderer.domElement)

    /* A lost WebGL context is not recoverable by carrying on: three.js stops
       having a GL object to draw with, and every later frame is silently a no-op.
       On a machine that is never restarted - which is the entire premise of a
      值守屏 - one driver reset would therefore leave a blank wall for a week, the
       worst possible failure here because it looks like "nothing is wrong" (S4 §2.4). */
    const canvas = this.renderer.domElement
    this._onCtxLost = (ev) => {
      ev.preventDefault() // without this the browser never fires `restored`
      this._contextLost = true
      cancelAnimationFrame(this._raf)
      this._raf = null
      this.onContextLost?.()
      /* Requesting the restore here is the difference between "the driver had a
         hiccup and the wall came back" and "the wall needs someone to press F5".
         Nobody is going to press F5 on a 副屏. If it comes back, the handler
         below repaints; if it does not, the caller's fuse ends up on the CSS
         wall, which is a result and not a silence. */
      this._lce = canvas.getContext(this.renderer.isWebGL2 ? 'webgl2' : 'webgl')
        ?.getExtension('WEBGL_lose_context') || null
      setTimeout(() => { if (this._contextLost) this._lce?.restoreContext?.() }, 1500)
    }
    this._onCtxRestored = () => {
      this._contextLost = false
      this._resize()
      // Buffers and textures died with the context; repaint everything from the
      // last snapshot rather than waiting for the next 2s push.
      this._acc = 1
      if (!this._raf && this._visible) this._raf = requestAnimationFrame(this._animate)
      this.onContextRestored?.()
    }
    canvas.addEventListener('webglcontextlost', this._onCtxLost)
    canvas.addEventListener('webglcontextrestored', this._onCtxRestored)

    this.labelRenderer = new CSS2DRenderer()
    this.labelRenderer.setSize(w, h)
    const ld = this.labelRenderer.domElement
    ld.style.position = 'absolute'
    ld.style.top = '0'
    ld.style.left = '0'
    ld.style.pointerEvents = 'none'
    this.container.appendChild(ld)

    this._resize = () => {
      const cw = this.container.clientWidth, ch = this.container.clientHeight
      if (!cw || !ch) return
      this.camera.aspect = cw / ch
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(cw, ch)
      this.labelRenderer.setSize(cw, ch)
    }
    this._ro = new ResizeObserver(this._resize)
    this._ro.observe(this.container)

    /* Hidden tab / screensaver / a laptop lid = no GPU work. The wall display is
       usually *the* visible surface, but this same renderer class also backs the
       拓扑 tab, where nobody is watching while you are on 总览. */
    this._onVisibility = () => {
      this._visible = !document.hidden
      if (this._visible) {
        // Draw again immediately rather than letting the accumulator sit idle.
        this._acc = 1
        if (!this._raf && !this._contextLost) this._raf = requestAnimationFrame(this._animate)
      } else if (this._raf) {
        cancelAnimationFrame(this._raf)
        this._raf = null
      }
    }
    document.addEventListener('visibilitychange', this._onVisibility)
  }

  _initScene() {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(GROUND.bg)

    this.camera = new THREE.PerspectiveCamera(
      42, (this.container.clientWidth || 800) / (this.container.clientHeight || 600), 0.1, 200)
    /* 陈列架机位：yaw 恒为 0（正视，剪影的宽高比不被透视剪切掉——甲档裁的是"不做斜视角"），
       只留 tiltRatio 那点俯角。第一次 update() 由 _fitShelf 按容器重算，这里的初值只是
       为了在取景之前也是一台陈列架相机，不是原来那台 37° 俯拍的环形相机。 */
    this.camera.position.set(0, 1 + 21 * SHELF.tiltRatio, 21)

    /* Read-only in kiosk: a wall nobody touches must not be able to end up
       rotated into an unreadable angle, and skipping the control drops a
       per-frame damping update (S4 §0). */
    if (this.interactive) {
      this.controls = new OrbitControls(this.camera, this.renderer.domElement)
      this.controls.target.set(0, 1, 0)
      this.controls.enableDamping = true
      this.controls.dampingFactor = 0.08
      this.controls.maxPolarAngle = Math.PI * 0.47
      this.controls.minDistance = 8
      this.controls.maxDistance = 45
      this.controls.enablePan = false
    } else {
      /* OrbitControls.update() was also what aimed the camera. Without it the
         lens keeps its default +Z orientation and the whole scene drifts off
         frame - so the fixed kiosk framing has to be stated explicitly. */
      this.camera.lookAt(0, 1, 0)
    }

    /* V3 翻暗 前置 4.0 (任务书 §5.1): the paper-era rig's white ambient of 0.75
       lifted the whole dark ground toward neutral grey - R-3's depth-by-
       brightening error, occurring in the lighting channel. The rig now reads
       from `palette.LIGHTING`, so the one knob this cut leaves open (how dark is
       too dark, and does the ivory key survive) is one block, in one file,
       tunable in front of the screen. Values are first guesses: 未验证，交人眼看一次. */
    this.scene.add(new THREE.AmbientLight(toRGB(LIGHTING.ambient.color), LIGHTING.ambient.intensity))
    const key = new THREE.DirectionalLight(toRGB(LIGHTING.key.color), LIGHTING.key.intensity)
    key.position.set(8, 18, 10)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(toRGB(LIGHTING.fill.color), LIGHTING.fill.intensity)
    fill.position.set(-10, 8, -8)
    this.scene.add(fill)

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(13, 48).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: toRGB(GROUND.plate), roughness: 1 }))
    ground.position.y = -0.05
    this.scene.add(ground)
    const grid = new THREE.GridHelper(24, 24, toRGB(GROUND.gridMajor), toRGB(GROUND.gridMinor))
    grid.position.y = 0
    this.scene.add(grid)

    this._resize()
  }

  _labelDiv(name, sub) {
    const div = document.createElement('div')
    div.className = 'topo-label'
    div.innerHTML = `<div class="tl-name">${name}</div><div class="tl-sub">${sub}</div>`
    return div
  }

  /* ---------- data update ---------- */

  /**
   * nodes: [{ id, name, deviceLevel, linkLevel, online, absent, load,
   *           links: [{ key, name, rtt, loss, level }] }]
   * 只读 id / name / deviceLevel / online / absent / load。
   * linkLevel 与 links 仍在推送里（详情页要用），本场景不再消费它们——见文件头。
   */
  update(nodes) {
    this._nodeList = nodes
    const ids = new Set(nodes.map(n => n.id))
    for (const [id, rec] of this.nodes) {
      if (!ids.has(id)) { this._disposeObject(rec.group); this.nodes.delete(id) }
    }

    /* 陈列架排版（任务书 B §1.1）：站一排，每格 SHELF.slotWidthPx(240px) 量级；
       容器宽度装不下 maxSlotsPerRow 格即折第二排（往上层，前排不遮后排）。
       折行阈值 960px = maxSlotsPerRow × slotWidthPx，是 shelfGrid() 里一个 floor()，
       可核对，见 lib/silhouette.js。调用方预排序，故席位顺序确定。 */
    const { cols } = shelfGrid(nodes.length, this.container.clientWidth || 800)
    let halfW = 0
    let topY = 0
    let bottomY = Infinity
    nodes.forEach((n, i) => {
      const x = ((i % cols) - (cols - 1) / 2) * SHELF.slotPitchWorld
      const y = SHELF.baseY + Math.floor(i / cols) * SHELF.rowPitchWorld
      let rec = this.nodes.get(n.id)
      if (!rec) {
        rec = this._makeNode(n)
        this.nodes.set(n.id, rec)
      }
      this._applyTier(rec, n)
      rec.group.position.set(x, y, 0)
      /* S1b ABSENT: a temporary node that left is not an incident, so it must
         not wear the same grey as a lost persistent node. Lighter + shrunk is
         readable without adding a fifth status colour. */
      rec.group.scale.setScalar(n.absent ? 0.72 : 1)
      const devColor = n.absent ? ABSENT : n.online ? (LC[n.deviceLevel] ?? LC.OK) : LC.OFFLINE
      /* V3 假辉光·案甲 (任务书 §5.1): the body's own colour doubles as its
         emissive, exactly like A1's PCB traces (`TopologyRenderer.js:809-815`) -
         no second colour enters the scene, so this adds no new hue to a channel
         R-1 has already spent. Both setters ride the same push, because
         `devColor` changes every update: a body that goes CRIT while its
         emissive still holds last push's green is "one fact, two homes" with an
         alarm on top of it. Intensity is derived from `load` here and never
         accumulated (`TopologyRenderer.js:1043-1052` records that drift). */
      rec.bodyMat.color.setHex(devColor)
      rec.bodyMat.emissive.setHex(devColor)
      rec.bodyMat.emissiveIntensity = glowIntensity(n)
      const size = silhouetteSize(rec.tier)
      const bodyTopY = y - SHELF.bodySeatY + size.height
      halfW = Math.max(halfW, Math.abs(x) + size.width / 2)
      topY = Math.max(topY, bodyTopY + SHELF.labelAboveBody + SHELF.plateHalfHeight)
      bottomY = Math.min(bottomY, y - SHELF.bodySeatY - SHELF.plinthThickness / 2)
      /* 诚实性红线：牌面上那行小字原来写的是 rtt/丢包（链路读数），链路这一维
         明着撤出墙之后，它只剩"这机器不在场"两种说法——空的那一行不补新话。 */
      rec.labelEl.querySelector('.tl-name').textContent = n.name
      rec.labelEl.querySelector('.tl-sub').textContent =
        n.absent ? '离场（临时节点，不报警）' : !n.online ? '失联' : ''
    })

    /* Kiosk 取景每次都算（容器宽度会变，折行也随之变）；交互页只算第一次，
       之后镜头归操作者的轨道，不抢回来。 */
    if (nodes.length && (!this.interactive || !this._framedOnce)) {
      this._framedOnce = true
      this._fitShelf(halfW + SHELF.sidePad, topY, bottomY)
    }
  }

  /**
   * One host = one box, sized by its own tier (任务书 B §1.2).
   * 真比例：几何 = ratio × unit 的绝对值，不随槽口归一化。槽口（SHELF.slotPitchWorld
   * 3.4 世界单位 = 墙上 240px 一格）只是**席位间距**，不是尺寸的模子：机架档机体
   * 2.56 宽、笔记本档 1.44、微型档 0.7，三档各是各的，槽口对谁都不改制。
   * 档变了就换几何并释放旧的——只换 position 会让旧模子留在显存里（S4 §2.4）。
   */
  _applyTier(rec, n) {
    const tier = silhouetteTierOf(n)
    if (rec.tier === tier) return
    const { height, width, depth } = silhouetteSize(tier)
    rec.body.geometry.dispose()
    rec.body.geometry = new THREE.BoxGeometry(width, height, depth)
    rec.body.position.y = -SHELF.bodySeatY + height / 2
    rec.base.geometry.dispose()
    rec.base.geometry = new THREE.BoxGeometry(
      width + SHELF.plinthMargin * 2, SHELF.plinthThickness, depth + SHELF.plinthMargin * 2)
    rec.label.position.y = -SHELF.bodySeatY + height + SHELF.labelAboveBody
    rec.tier = tier
  }

  _makeNode(n) {
    const tier = silhouetteTierOf(n)
    const { height, width, depth } = silhouetteSize(tier)
    const group = new THREE.Group()
    /* 地牌：原来它是「底座 = 链路色」的载体，链路撤出墙之后它只剩一块台板——
       颜色沿用 GRAY（palette 已有的中性色），不新增也不修改任何色值。
       厚度 0.22 与「牌顶在组原点下 0.44」是星型时代的现值，数值搬进参数表，
       好让折行不变量（地牌不撞邻格、标签不压上层牌）能被自检从表里算出来。 */
    const baseMat = new THREE.MeshStandardMaterial({ color: GRAY, roughness: 0.8 })
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(
        width + SHELF.plinthMargin * 2, SHELF.plinthThickness, depth + SHELF.plinthMargin * 2),
      baseMat)
    base.position.y = -(SHELF.bodySeatY + SHELF.plinthThickness / 2)
    base.userData.hostId = n.id
    group.add(base)
    /* The body is born dark (intensity 0): `update()`, the same pass that
       creates it, is the only place that decides how busy a machine looks -
       never `_animate()`, because this glow is a reading, not an event.
       `emissive` is seeded to the same value as `color` so the two can never be
       observed disagreeing, which is the entire premise of 案甲. */
    const bodyMat = new THREE.MeshStandardMaterial({
      color: LC.OK,
      roughness: 0.55,
      flatShading: true,
      emissive: LC.OK,
      emissiveIntensity: 0,
    })
    const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), bodyMat)
    body.position.y = -SHELF.bodySeatY + height / 2
    body.userData.hostId = n.id
    group.add(body)
    const label = new CSS2DObject(this._labelDiv(n.name, ''))
    label.position.set(0, -SHELF.bodySeatY + height + SHELF.labelAboveBody, 0)
    group.add(label)
    group.position.y = SHELF.baseY
    this.scene.add(group)
    return { group, body, base, bodyMat, baseMat, label, labelEl: label.element, tier }
  }

  /* ---------- lifecycle helpers (S4 §2.4) ---------- */

  /**
   * Recursively release every geometry/material under an object and detach it.
   *
   * The 拓扑 tab used to leak on every host removal: scene.remove() drops the
   * parent pointer but the buffers stay on the GPU, and a node's CSS2D label is
   * a real DOM element the label renderer keeps compositing. On a panel that is
   * never restarted - the kiosk's whole premise - add/remove churn (retiring a
   * node, switching 名册) walks memory up forever.
   */
  _disposeObject(obj) {
    if (!obj) return
    obj.traverse((o) => {
      o.geometry?.dispose?.()
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : [])
      for (const m of mats) m.dispose?.()
      // CSS2DObject: three only forgets it, the browser does not
      if (o.isCSS2DObject && o.element?.parentNode) o.element.parentNode.removeChild(o.element)
    })
    if (obj.parent) obj.parent.remove(obj)
  }

  /* ---------- framing ---------- */

  /**
   * 陈列架取景：把整面架子（含地牌与标签牌）装进容器，yaw 恒 0。
   * 相机沿 +Z 退到能同时装下宽和高的距离，再按 tiltRatio 抬高——只抬不转，
   * 所以每台机器的正立面仍垂直于视线，高宽比这个识别特征不被透视剪切。
   * fov / near / far / maxCameraDistance 都是现值，本包没动它们。
   */
  _fitShelf(halfW, topY, bottomY) {
    const centerY = (topY + bottomY) / 2
    const halfH = Math.max(0.5, (topY - bottomY) / 2)
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    const aspect = Math.max(0.1, this.camera.aspect)
    const dist = Math.min(SHELF.maxCameraDistance,
      Math.max(halfH / tanV, halfW / (tanV * aspect)) * SHELF.fitPadding)
    this.camera.position.set(0, centerY + dist * SHELF.tiltRatio, dist)
    this.controls?.target.set(0, centerY, 0)
    this.camera.lookAt(0, centerY, 0)
  }

  /* ---------- picking ---------- */

  enableClicks() {
    if (!this.interactive) return // kiosk: nothing to pick, nothing to accidentally move
    const el = this.renderer.domElement
    this._onDown = (ev) => { this._downPt = [ev.clientX, ev.clientY] }
    this._onUp = (ev) => {
      if (!this._downPt) return
      const moved = Math.hypot(ev.clientX - this._downPt[0], ev.clientY - this._downPt[1])
      this._downPt = null
      if (moved > 5 || !this.onNodeClick) return
      const rect = el.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1)
      const rc = new THREE.Raycaster()
      rc.setFromCamera(ndc, this.camera)
      const meshes = []
      for (const rec of this.nodes.values()) meshes.push(rec.body, rec.base)
      const hit = rc.intersectObjects(meshes)[0]
      if (hit?.object?.userData?.hostId) this.onNodeClick(hit.object.userData.hostId)
    }
    el.addEventListener('pointerdown', this._onDown)
    el.addEventListener('pointerup', this._onUp)
  }

  /* ---------- animation ---------- */

  _animate() {
    this._raf = requestAnimationFrame(this._animate)
    /* getDelta() is read on *every* rAF, cap or no cap: it is the time since the
       previous call, so a skipped frame still counts toward the fpsCap
       accumulator. Sampling first and gating after would stall the cap.
       The clamp is the reverse hazard - a tab that was in the background reports
       one huge delta, and the accumulator would spend it as several frames at
       once. (原来这段还有第二句：脉冲点会瞬移到线的尽头。连线随星型一起撤了，
       dt 现在只有 _acc 一个消费者；钳位与两条通道本身一个字没改。) */
    const dt = Math.min(0.1, this._clock.getDelta())
    /* fpsCap is a skip, not a slower clock (S4 §1.4): a status wall is not a game,
       and half the frame rate on a GT 1030 is the cheapest headroom in the app. */
    if (this.fpsCap > 0) {
      this._acc += dt
      if (this._acc < 1 / this.fpsCap) return
      this._acc = 0
    }
    this.controls?.update()
    this.renderer.render(this.scene, this.camera)
    this.labelRenderer.render(this.scene, this.camera)
    this.onFrame?.()
  }

  dispose() {
    cancelAnimationFrame(this._raf)
    this._raf = null
    this._ro.disconnect()
    document.removeEventListener('visibilitychange', this._onVisibility)
    const canvas = this.renderer.domElement
    canvas.removeEventListener('webglcontextlost', this._onCtxLost)
    canvas.removeEventListener('webglcontextrestored', this._onCtxRestored)
    if (this._onDown) {
      canvas.removeEventListener('pointerdown', this._onDown)
      canvas.removeEventListener('pointerup', this._onUp)
    }
    // Everything the scene holds except lights and the camera
    for (const rec of this.nodes.values()) this._disposeObject(rec.group)
    this.nodes.clear()
    this.scene.traverse((o) => {
      if (o.isMesh || o.isLine || o.isPoints) {
        o.geometry?.dispose?.()
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of mats) m?.dispose?.()
      } else if (o.isCSS2DObject && o.element?.parentNode) {
        o.element.parentNode.removeChild(o.element)
      }
    })
    this.controls?.dispose()
    this.renderer.dispose()
    for (const el of [this.renderer.domElement, this.labelRenderer.domElement]) {
      if (el.parentElement) el.parentElement.removeChild(el)
    }
  }
}

/* V3 假辉光·案甲 (任务书 §5.1) — 机体亮度 = 负载的一维读数，不是事件。
 *
 * -1 from `loadOf` 是「没有指标」，不是「0% 负载」，所以两者必须长得不一样：
 *   无数据 -> 0（机体哑掉，色表 R-2 的「更暗 = 这里没信息」）。把它当 0% 处理就是
 *   让「没数据」冒充「很闲」，这一刀最不能接受的错。
 * - 离场 / 失联同样为 0：不在场的机器没有「忙不忙」这回事。
 * - 上限 0.30（load >= 100 时取到）是刻意压住的：emissive 加的是与朝向无关的常量项，
 *   抬高了会冲平前置 4.0 刚买回来的面明暗（受光面 1.35 / 背光面 0.65，层次比 2.08）——
 *   层次靠面（R-3），辉光不吃层次。
 * - 纯函数、只依赖当次推送的 `load`：无时间项、无自累加（H30 的动效通道不在本刀）。
 * - `load` 缺失/非数字同样为 0，绝不把 NaN 写进材质。 */
const GLOW_FLOOR = 0.05   // 有数据但空载
const GLOW_SPAN = 0.25    // 0 -> 满负载，天花板 0.30

function glowIntensity(n) {
  const load = n.load
  if (n.absent || !n.online || !Number.isFinite(load) || load < 0) return 0
  return GLOW_FLOOR + (Math.min(100, Math.max(0, load)) / 100) * GLOW_SPAN
}
