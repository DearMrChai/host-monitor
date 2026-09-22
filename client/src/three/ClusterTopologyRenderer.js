import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { STATE, NEUTRAL, GROUND, LIGHTING, toRGB } from '../lib/palette.js'

/**
 * ClusterTopologyRenderer (P3 / V1.5 star topology)
 * =================================================
 * Server hub block at center, gateway block beside it, fleet nodes on a
 * ring. Each node draws one edge per probe target: edge color = link
 * level (green/yellow/red), gray dashed = down (100% loss) or no data.
 * A pulse dot travels node->endpoint with speed ~ 1/RTT.
 * Block top color = device level, base slab color = link level, so
 * "device problem vs link problem" is readable on one glance.
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

const HUB_POS = new THREE.Vector3(0, 1.1, 0)
const GW_POS = new THREE.Vector3(3.4, 0.6, 0)

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
    this.nodes = new Map()   // host_id -> { group, bodyMat, baseMat, labelEl, pos }
    this.stubs = new Map()   // target id -> { group, labelEl } for unmatched probe targets
    this._stubSlot = 0       // monotonic, so a recreated stub never lands on a survivor
    this.edges = []          // { line, mat, pulse, from, to, rtt, phase }
    this._edgeSig = ''
    this._clock = new THREE.Clock()
    this._downPt = null
    this._visible = true
    this._contextLost = false
    this._t = 0            // own clock: see _animate's getDelta() note
    this._acc = 0          // fpsCap accumulator
    this.onNodeClick = null  // (hostId) => void
    this.onFrame = null      // () => void - the kiosk's fps sampler lives here
    this.onContextLost = null     // () => void
    this.onContextRestored = null // () => void

    this._initRenderer()
    this._initScene()
    this._buildFixed()

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
    this.camera.position.set(0, 16, 21)

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

  _buildFixed() {
    this.hub = this._makeBlock('Server\n监控中枢', HUB_POS, 2.4, 2.2, 2.4, 0x6b7a8f)
    this.gw = this._makeBlock('网关', GW_POS, 1.6, 1.1, 1.6, 0x8f9a7a)
  }

  _makeBlock(text, pos, bw, bh, bd, color) {
    const group = new THREE.Group()
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, flatShading: true })
    const body = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat)
    body.position.y = bh / 2
    group.add(body)
    group.position.copy(pos)
    const label = new CSS2DObject(this._labelDiv(text.split('\n')[0], text.split('\n')[1] || ''))
    label.position.set(0, bh + 0.7, 0)
    group.add(label)
    this.scene.add(group)
    return { group, mat, body, labelEl: label.element }
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
   */
  update(nodes) {
    this._nodeList = nodes
    const ids = new Set(nodes.map(n => n.id))
    for (const [id, n] of this.nodes) {
      if (!ids.has(id)) { this._disposeObject(n.group); this.nodes.delete(id) }
    }

    // stable ring layout (caller pre-sorts for deterministic order)
    const R = Math.max(6.5, nodes.length * 2.3)
    if (!this.interactive) this._fitRadius(R)
    nodes.forEach((n, i) => {
      const a = (i / nodes.length) * Math.PI * 2 - Math.PI / 2
      const pos = new THREE.Vector3(Math.cos(a) * R, 0.7, Math.sin(a) * R)
      let rec = this.nodes.get(n.id)
      if (!rec) {
        rec = this._makeNode(n)
        this.nodes.set(n.id, rec)
      }
      rec.group.position.copy(pos)
      rec.pos = pos
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
      rec.baseMat.color.setHex(n.linkLevel ? (LC[n.linkLevel] ?? GRAY) : GRAY)
      const serverLink = n.links.find(l => l.key === 'server')
      const rttTxt = n.absent ? '离场（临时节点，不报警）'
        : !n.online ? '失联'
        : serverLink ? (serverLink.rtt != null ? `↘${serverLink.rtt}ms 丢${serverLink.loss}%` : `↘— 丢${serverLink.loss}%`)
        : '链路无数据'
      rec.labelEl.querySelector('.tl-name').textContent = n.name
      rec.labelEl.querySelector('.tl-sub').textContent = rttTxt
    })

    this._rebuildEdges(nodes)
  }

  _makeNode(n) {
    const group = new THREE.Group()
    const baseMat = new THREE.MeshStandardMaterial({ color: GRAY, roughness: 0.8 })
    const base = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.22, 2.2), baseMat)
    base.position.y = -0.55
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
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.2, 1.5), bodyMat)
    body.position.y = 0.15
    body.userData.hostId = n.id
    group.add(body)
    const label = new CSS2DObject(this._labelDiv(n.name, ''))
    label.position.set(0, 1.9, 0)
    group.add(label)
    group.position.y = 0.7
    this.scene.add(group)
    return { group, body, base, bodyMat, baseMat, labelEl: label.element, pos: group.position }
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

  /** Fixed-frame kiosk: keep the ring inside the viewport as the roster grows. */
  _fitRadius(R) {
    // (0,16,21) framed R≈6.5 when the interactive view was designed; preserve
    // that direction, scale the distance.
    const base = this._baseDist ?? (this._baseDist = new THREE.Vector3(0, 16, 21).length())
    const dist = Math.min(60, Math.max(base, R * (base / 6.5)))
    this.camera.position.setLength(dist)
    this.camera.lookAt(0, 1, 0)
  }

  /* ---------- edges ---------- */

  _endpointOf(link, byId) {
    if (link.key === 'server') return { pos: HUB_POS.clone().setY(HUB_POS.y + 1.2), name: 'server' }
    if (link.key === 'gateway') return { pos: GW_POS.clone().setY(GW_POS.y + 0.6), name: 'gw' }
    const targetNode = byId.get(link.key)
    if (targetNode) return { pos: targetNode.pos.clone().setY(1.3), name: link.key }
    // unmatched key host -> small stub behind the gateway
    let stub = this.stubs.get(link.key)
    if (!stub) {
      // Monotonic slot, not stubs.size: a pruned-then-recreated target would
      // otherwise be laid out on top of a surviving neighbour.
      const idx = this._stubSlot++
      const p = new THREE.Vector3(-4.2 - (idx % 4) * 2.2, 0.35, -3.2 - Math.floor(idx / 4) * 2.2)
      stub = this._makeBlock(`${link.name}\n关键节点`, p, 1.0, 0.7, 1.0, 0xa89f8d)
      this.stubs.set(link.key, stub)
    }
    return { pos: stub.group.position.clone().setY(1.0), name: link.key, stubKey: link.key }
  }

  _rebuildEdges(nodes) {
    const byId = new Map(nodes.map(n => [n.id, this.nodes.get(n.id)]))
    let sig = ''
    for (const n of nodes) {
      for (const l of n.links) {
        sig += `${n.id}|${l.key}|${l.level}|${l.loss >= 100 || l.level == null ? 'g' : 'c'};`
      }
    }
    if (sig === this._edgeSig) {
      // structure unchanged: just refresh pulse speeds
      for (const e of this.edges) e.speed = e.pulse ? pulseSpeed(e.rtt) : 0
      return
    }
    this._edgeSig = sig
    this._clearEdges()

    const used = new Set()
    for (const n of nodes) {
      const rec = this.nodes.get(n.id)
      if (!rec || !n.online) continue
      const from = rec.pos.clone().setY(1.45)
      for (const l of n.links) {
        const ep = this._endpointOf(l, byId)
        if (ep.stubKey) used.add(ep.stubKey)
        const down = l.loss >= 100 || l.level == null
        const color = down ? GRAY : (LC[l.level] ?? LC.OK)
        const to = ep.pos
        const lineGeo = new THREE.BufferGeometry().setFromPoints([from, to])
        let mat, line
        if (down) {
          mat = new THREE.LineDashedMaterial({ color, dashSize: 0.35, gapSize: 0.28 })
          line = new THREE.Line(lineGeo, mat)
          line.computeLineDistances()
        } else {
          mat = new THREE.LineBasicMaterial({ color })
          line = new THREE.Line(lineGeo, mat)
        }
        this.scene.add(line)
        const pulse = down ? null : new THREE.Mesh(
          new THREE.SphereGeometry(0.13, 10, 10),
          new THREE.MeshBasicMaterial({ color }))
        if (pulse) this.scene.add(pulse)
        this.edges.push({
          line, mat, pulse, from, to, rtt: l.rtt,
          speed: pulse ? pulseSpeed(l.rtt) : 0,
          phase: Math.random(),
        })
      }
    }

    /* A stub is the picture of "we probe this but it is not on the board". Once
       nothing draws an edge to it any more - the target node joined the ring, or
       the probe was removed - the block has to leave with the edge, or the scene
       fills with monuments to old configuration. */
    for (const [key, stub] of this.stubs) {
      if (!used.has(key)) { this._disposeObject(stub.group); this.stubs.delete(key) }
    }
  }

  _clearEdges() {
    for (const e of this.edges) {
      this._disposeObject(e.line)
      if (e.pulse) this._disposeObject(e.pulse)
    }
    this.edges = []
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
       previous call, so a skipped frame still counts toward the pulse positions.
       Sampling first and gating after would freeze the animation for the frames
       it skips. The clamp is the reverse hazard - a tab that was in the background
       reports one huge delta, and every dot teleports to the end of its edge. */
    const dt = Math.min(0.1, this._clock.getDelta())
    this._t += dt
    /* fpsCap is a skip, not a slower clock (S4 §1.4): a status wall is not a game,
       and half the frame rate on a GT 1030 is the cheapest headroom in the app. */
    if (this.fpsCap > 0) {
      this._acc += dt
      if (this._acc < 1 / this.fpsCap) return
      this._acc = 0
    }
    const t = this._t
    for (const e of this.edges) {
      if (!e.pulse) continue
      const f = (e.speed * t + e.phase) % 1
      e.pulse.position.lerpVectors(e.from, e.to, f)
      const s = 0.7 + Math.sin(f * Math.PI) * 0.6   // fade at ends via scale, cheap
      e.pulse.scale.setScalar(Math.max(0.25, s))
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
    this._clearEdges()
    if (this._onDown) {
      canvas.removeEventListener('pointerdown', this._onDown)
      canvas.removeEventListener('pointerup', this._onUp)
    }
    // Everything the scene holds except lights and the camera
    for (const rec of this.nodes.values()) this._disposeObject(rec.group)
    for (const stub of this.stubs.values()) this._disposeObject(stub.group)
    this.nodes.clear()
    this.stubs.clear()
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

function pulseSpeed(rtt) {
  if (rtt == null) return 0.35
  return Math.min(1.2, Math.max(0.12, 1.2 / (1 + rtt / 15)))
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
