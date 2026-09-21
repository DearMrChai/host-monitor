import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { GROUND, NEUTRAL, STRUCT, COOLANT, toRGB } from '../lib/palette.js'

/**
 * TopologyRenderer (v3 - Realistic PCB)
 * ======================================
 * Renders host topology as a realistic motherboard:
 *   - PCB with copper traces, solder mask, mounting holes, SMD parts
 *   - CPU with LGA socket + gold pin grid + IHS
 *   - Manhattan-routed flat PCB traces for bus connections
 *   - Real-time metric visualization (glow/color by load)
 */

/* ============ Bus trace encoding ============ */

/* 色值一律读 palette.STRUCT（V3 暗底色表 §2.5），不再在场景里留纸面字面量：
   DOM 图例读 :root、这里读 STRUCT，而 check-tokens.mjs 把 12 对逐支钉住 —— 图例
   的紫和线的紫从此没法各改各的（任务书 §6.1，第 1 刀漏的那道闸）。
   线宽是这套编码的另一半，留在原处：它是几何，不是色。
   pcie_x1 有意不发色（§2.5 补 2）：它的纸面旧值距 --cpu 只有 ΔE 19、距 --dmi
   24，都低于 25 下限，收进族里就是制造"档多而互认不出"。x1 与 x4 的差别本来就由
   线宽 0.10 / 0.16 承载 —— 色相说"哪一组"，宽度说"第几档"。 */

const BUS_STYLE = {
  ddr:       { color: toRGB(STRUCT.ddr), width: 0.28, label: 'DDR' },
  pcie_x16:  { color: toRGB(STRUCT.pcie16), width: 0.24, label: 'PCIe x16' },
  pcie_x4:   { color: toRGB(STRUCT.pcie4), width: 0.16, label: 'PCIe x4' },
  pcie_x1:   { color: toRGB(STRUCT.pcie4), width: 0.10, label: 'PCIe x1' },
  nvlink:    { color: toRGB(STRUCT.nvlink), width: 0.26, label: 'NVLink' },
  dmi:       { color: toRGB(STRUCT.dmi), width: 0.14, label: 'DMI' },
  sata:      { color: toRGB(STRUCT.sata), width: 0.09, label: 'SATA' },
}

/* ============ Colors ============ */

const C = {
  pcb:          0x1b7a1b,   // Medium green solder mask (lighter)
  pcb_light:    0x24922a,
  copper:       0xb87333,   // Copper trace
  copper_dark:  0x8b5a2b,
  gold:         0xffd700,   // Gold pins
  gold_dark:    0xb8860b,
  socket:       0x1a1a1a,   // CPU socket plastic
  socket_metal: 0x8c8c8c,
  cpu_ihs:      0xb0b0b0,   // Silver IHS
  cpu_pcb:      0x2a6b3a,   // CPU substrate (lighter green)
  heatsink:     0xa8a8a8,
  ram_pcb:      0x1a6b1a,
  ram_spread:   0x2a2a2a,
  gpu_pcb:      0x1a1a1a,
  gpu_shroud:   0x2d2d2d,
  m2_pcb:       0x1b7a1b,
  pch_body:     0x1a1a1a,
  nic_pcb:      0x1a6b1a,
  slot_black:   0x111111,
  smd_body:     0x1a1a1a,
  smd_cap:      0x3d3d3d,
  solder:       0xc0c0c0,
}

/* ============ Layout (units ~ cm) ============ */

const BOARD = { w: 30.5, d: 24.4 }
const CPU_POS = { x: -4, z: -5 }
const CPU_SIZE = { w: 4.5, d: 4.5 }
const DIMM_START = { x: 2.5, z: -7 }
const DIMM_GAP = 1.5
const PCIE_START = { x: -5, z: 3 }
const PCIE_GAP = 3.2
const M2_POS = { x: -4, z: -0.3 }
const PCH_POS = { x: 8, z: 6 }
const NIC_POS = { x: 9, z: -5 }

/* ============ Main Class ============ */

export class TopologyRenderer {
  constructor(container, topology) {
    this.container = container
    this.topology = topology
    this.components = new Map()
    this.links = []
    this._pickables = []
    this._ray = new THREE.Raycaster()
    this._pointer = new THREE.Vector2()
    this._metrics = null
    this._clock = new THREE.Clock()

    this._initRenderer()
    this._initScene()
    this._buildTopology()

    this._animate = this._animate.bind(this)
    this._raf = requestAnimationFrame(this._animate)
  }

  /* ---------- Renderer / Scene ---------- */

  _initRenderer() {
    const w = this.container.clientWidth || 800
    const h = this.container.clientHeight || 600
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.renderer.setSize(w, h)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.container.appendChild(this.renderer.domElement)

    this.labelRenderer = new CSS2DRenderer()
    this.labelRenderer.setSize(w, h)
    const ld = this.labelRenderer.domElement
    ld.style.position = 'absolute'
    ld.style.top = '0'
    ld.style.left = '0'
    ld.style.pointerEvents = 'none'
    this.container.appendChild(ld)

    this._onResize = () => {
      const cw = this.container.clientWidth, ch = this.container.clientHeight
      if (!cw || !ch) return
      this.camera.aspect = cw / ch
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(cw, ch)
      this.labelRenderer.setSize(cw, ch)
    }
    this._ro = new ResizeObserver(this._onResize)
    this._ro.observe(this.container)
  }

  _initScene() {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(GROUND.bg)

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200)
    this.camera.position.set(18, 22, 26)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 0, 0)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxPolarAngle = Math.PI * 0.47
    this.controls.minDistance = 8
    this.controls.maxDistance = 65

    // Lighting - adjusted for light background
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const key = new THREE.DirectionalLight(0xfff5e0, 0.9)
    key.position.set(10, 25, 12)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.camera.near = 1; key.shadow.camera.far = 50
    key.shadow.camera.left = -18; key.shadow.camera.right = 18
    key.shadow.camera.top = 18; key.shadow.camera.bottom = -18
    this.scene.add(key)

    const fill = new THREE.DirectionalLight(0xddeeff, 0.4)
    fill.position.set(-12, 10, -10)
    this.scene.add(fill)

    const rim = new THREE.DirectionalLight(0xffffff, 0.2)
    rim.position.set(0, 3, -20)
    this.scene.add(rim)

    this._onResize()
  }

  /* ---------- Build ---------- */

  _buildTopology() {
    const t = this.topology
    this._buildMotherboard()
    this._buildCPU(t.cpu)
    this._buildMemory(t.memory)
    this._buildGPU(t.gpu || [])
    this._buildStorage(t.storage || [])
    this._buildNetwork(t.network || [])
    if (t.pch) this._buildPCH(t.pch)
    this._buildLinks()
    if (t.interconnects?.length) this._buildInterconnects(t.interconnects)
  }

  /* ===== MOTHERBOARD (realistic PCB) ===== */

  _buildMotherboard() {
    const group = new THREE.Group()

    // Main PCB board - layered look (FR4 substrate + solder mask)
    const pcbGeo = new THREE.BoxGeometry(BOARD.w, 0.16, BOARD.d)
    const pcbMat = new THREE.MeshStandardMaterial({
      color: C.pcb, roughness: 0.65, metalness: 0.1,
    })
    const pcb = new THREE.Mesh(pcbGeo, pcbMat)
    pcb.position.y = -0.08
    pcb.receiveShadow = true
    group.add(pcb)

    // PCB edge (exposed FR4 - lighter brown/green at edges)
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0x3d8a2e, roughness: 0.8 })
    const edgeGeo = new THREE.BoxGeometry(BOARD.w + 0.05, 0.12, BOARD.d + 0.05)
    const edge = new THREE.Mesh(edgeGeo, edgeMat)
    edge.position.y = -0.1
    group.add(edge)

    // Copper trace pattern on surface (procedural decorative traces)
    this._addDecoTraces(group)

    // Mounting holes (9 standard ATX positions)
    const holePositions = [
      [-14, -11], [-14, 0], [-14, 11],
      [0, -11], [0, 11],
      [14, -11], [14, 0], [14, 11],
    ]
    const holeMat = new THREE.MeshStandardMaterial({ color: C.solder, roughness: 0.3, metalness: 0.8 })
    for (const [hx, hz] of holePositions) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.1, 8, 16), holeMat)
      ring.rotation.x = -Math.PI / 2
      ring.position.set(hx, 0.01, hz)
      group.add(ring)
    }

    // Scattered SMD components (tiny resistors/capacitors for realism)
    this._addSMDParts(group)

    // Silkscreen text area (white outline rectangles like real PCB)
    const silkMat = new THREE.MeshBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.15 })
    // CPU socket outline
    const silkGeo = new THREE.PlaneGeometry(CPU_SIZE.w + 1.5, CPU_SIZE.d + 1.5)
    const silk = new THREE.Mesh(silkGeo, silkMat)
    silk.rotation.x = -Math.PI / 2
    silk.position.set(CPU_POS.x, 0.02, CPU_POS.z)
    group.add(silk)

    this.scene.add(group)
  }

  /** Decorative copper traces scattered on PCB surface */
  _addDecoTraces(group) {
    const traceMat = new THREE.MeshStandardMaterial({
      color: C.copper_dark, roughness: 0.4, metalness: 0.7,
      transparent: true, opacity: 0.4,
    })
    // Generate pseudo-random trace lines
    const seed = 42
    let s = seed
    const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }

    for (let i = 0; i < 60; i++) {
      const len = 2 + rand() * 8
      const thick = 0.04 + rand() * 0.06
      const x = (rand() - 0.5) * BOARD.w * 0.9
      const z = (rand() - 0.5) * BOARD.d * 0.9
      const horizontal = rand() > 0.5

      const geo = horizontal
        ? new THREE.BoxGeometry(len, 0.01, thick)
        : new THREE.BoxGeometry(thick, 0.01, len)
      const trace = new THREE.Mesh(geo, traceMat)
      trace.position.set(x, 0.005, z)
      group.add(trace)
    }

    // Some via holes (tiny copper rings)
    const viaMat = new THREE.MeshStandardMaterial({ color: C.copper, roughness: 0.3, metalness: 0.8 })
    for (let i = 0; i < 30; i++) {
      const x = (rand() - 0.5) * BOARD.w * 0.85
      const z = (rand() - 0.5) * BOARD.d * 0.85
      const via = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.02, 8), viaMat)
      via.position.set(x, 0.01, z)
      group.add(via)
    }
  }

  /** Tiny SMD components (caps, resistors) for realism */
  _addSMDParts(group) {
    const bodyMat = new THREE.MeshStandardMaterial({ color: C.smd_body, roughness: 0.7 })
    const capMat = new THREE.MeshStandardMaterial({ color: C.smd_cap, roughness: 0.5, metalness: 0.3 })
    const termMat = new THREE.MeshStandardMaterial({ color: C.solder, roughness: 0.3, metalness: 0.8 })

    let s = 137
    const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }

    for (let i = 0; i < 40; i++) {
      const x = (rand() - 0.5) * BOARD.w * 0.85
      const z = (rand() - 0.5) * BOARD.d * 0.85
      // Skip areas occupied by major components
      if (Math.abs(x - CPU_POS.x) < 4 && Math.abs(z - CPU_POS.z) < 4) continue
      if (x > 0 && x < 8 && z < -2) continue  // DIMM area

      const w = 0.15 + rand() * 0.25
      const h = 0.08 + rand() * 0.12
      const d = 0.1 + rand() * 0.15
      const isCap = rand() > 0.6

      const body = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        isCap ? capMat : bodyMat
      )
      body.position.set(x, h / 2 + 0.01, z)
      group.add(body)

      // Silver terminals on ends
      if (!isCap) {
        const t1 = new THREE.Mesh(new THREE.BoxGeometry(0.04, h * 0.8, d), termMat)
        t1.position.set(x - w / 2, h / 2 + 0.01, z)
        group.add(t1)
        const t2 = new THREE.Mesh(new THREE.BoxGeometry(0.04, h * 0.8, d), termMat)
        t2.position.set(x + w / 2, h / 2 + 0.01, z)
        group.add(t2)
      }
    }

    // A few electrolytic capacitors (cylinders)
    const elecMat = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.6 })
    const elecPositions = [[12, -9], [12, -7], [-13, 8], [-13, 10], [6, 10]]
    for (const [ex, ez] of elecPositions) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.2, 12), elecMat)
      cap.position.set(ex, 0.6, ez)
      cap.castShadow = true
      group.add(cap)
      // Top marking
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.02, 12), termMat)
      top.position.set(ex, 1.21, ez)
      group.add(top)
    }
  }

  /* ===== CPU (realistic LGA socket + substrate + IHS) ===== */

  _buildCPU(cpu) {
    if (!cpu) return
    const group = new THREE.Group()
    group.position.set(CPU_POS.x, 0, CPU_POS.z)

    const subW = CPU_SIZE.w
    const subD = CPU_SIZE.d

    // --- Green substrate (rounded), sits flush on the board (NO floating) ---
    const subShape = this._roundedRectShape(subW, subD, 0.25)
    const subGeo = new THREE.ExtrudeGeometry(subShape, {
      depth: 0.28, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2, curveSegments: 6,
    })
    subGeo.rotateX(-Math.PI / 2)
    subGeo.computeBoundingBox()
    subGeo.translate(0, -subGeo.boundingBox.min.y, 0)   // normalize bottom to y=0
    const subH = subGeo.boundingBox.max.y
    const subBaseY = 0.02                              // flush on PCB surface
    const subMat = new THREE.MeshStandardMaterial({ color: 0x1f7a2e, roughness: 0.5, metalness: 0.15 })
    const sub = new THREE.Mesh(subGeo, subMat)
    sub.position.y = subBaseY
    sub.castShadow = true
    group.add(sub)
    const subTopY = subBaseY + subH

    // --- Gold pins radiating outward (gull-wing leads, tips touch board) ---
    const pinMat = new THREE.MeshStandardMaterial({ color: 0xd99a2b, roughness: 0.25, metalness: 0.9 })
    const pinsPerSide = 9
    const pinLen = 1.5
    const tilt = 0.15
    const pinY = subBaseY + subH * 0.5
    for (let side = 0; side < 4; side++) {
      for (let i = 0; i < pinsPerSide; i++) {
        const t = (i / (pinsPerSide - 1)) - 0.5
        const off = t * (subW * 0.82)
        const pin = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, pinLen), pinMat)
        if (side === 0) { pin.position.set(off, pinY, subD / 2 + pinLen / 2 - 0.15); pin.rotation.x = tilt }
        else if (side === 1) { pin.position.set(off, pinY, -subD / 2 - pinLen / 2 + 0.15); pin.rotation.x = -tilt }
        else if (side === 2) { pin.geometry = new THREE.BoxGeometry(pinLen, 0.07, 0.16); pin.position.set(subW / 2 + pinLen / 2 - 0.15, pinY, off); pin.rotation.z = -tilt }
        else { pin.geometry = new THREE.BoxGeometry(pinLen, 0.07, 0.16); pin.position.set(-subW / 2 - pinLen / 2 + 0.15, pinY, off); pin.rotation.z = tilt }
        pin.castShadow = true
        group.add(pin)
      }
    }

    // --- Silver IHS lid (rounded, domed), sits directly on substrate top ---
    const ihsW = subW * 0.74
    const ihsD = subD * 0.74
    const ihsShape = this._roundedRectShape(ihsW, ihsD, 0.55)
    const ihsGeo = new THREE.ExtrudeGeometry(ihsShape, {
      depth: 0.5, bevelEnabled: true, bevelThickness: 0.14, bevelSize: 0.14, bevelSegments: 4, curveSegments: 10,
    })
    ihsGeo.rotateX(-Math.PI / 2)
    ihsGeo.computeBoundingBox()
    ihsGeo.translate(0, -ihsGeo.boundingBox.min.y, 0)
    const ihsH = ihsGeo.boundingBox.max.y
    const ihsMat = new THREE.MeshStandardMaterial({
      color: 0xc9c9c9, roughness: 0.10, metalness: 0.95,
      emissive: 0x000000, emissiveIntensity: 0,
    })
    const ihs = new THREE.Mesh(ihsGeo, ihsMat)
    ihs.position.y = subTopY
    ihs.castShadow = true
    group.add(ihs)
    const ihsTopY = subTopY + ihsH

    // --- Printed text on IHS top ---
    const tex = this._makeCpuTexture(cpu)
    const textMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true })
    const textPlane = new THREE.Mesh(new THREE.PlaneGeometry(ihsW * 0.85, ihsD * 0.85), textMat)
    textPlane.rotation.x = -Math.PI / 2
    textPlane.position.y = ihsTopY + 0.01
    group.add(textPlane)

    // --- Orientation marker (golden dot) ---
    const dotMat = new THREE.MeshStandardMaterial({ color: 0xffd700, roughness: 0.3, metalness: 0.85 })
    const dot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.03, 12), dotMat)
    dot.position.set(-subW / 2 + 0.4, subTopY + 0.01, -subD / 2 + 0.4)
    group.add(dot)

    // --- CSS2D label above ---
    const label = this._makeLabel(cpu.model || 'CPU', 'cpu-label')
    label.position.set(0, ihsTopY + 1.2, 0)
    group.add(label)

    this.scene.add(group)
    this._registerPickable(group, 'cpu')
    this.components.set('cpu', {
      group, ihsMat, label, _alarmPhase: 0,
      pos: { ...CPU_POS }, type: 'cpu'
    })
  }

  /** Rounded-rectangle Shape helper (for extruded PCB / IHS). */
  _roundedRectShape(w, d, r) {
    const s = new THREE.Shape()
    const x = -w / 2, y = -d / 2
    s.moveTo(x + r, y)
    s.lineTo(x + w - r, y)
    s.quadraticCurveTo(x + w, y, x + w, y + r)
    s.lineTo(x + w, y + d - r)
    s.quadraticCurveTo(x + w, y + d, x + w - r, y + d)
    s.lineTo(x + r, y + d)
    s.quadraticCurveTo(x, y + d, x, y + d - r)
    s.lineTo(x, y + r)
    s.quadraticCurveTo(x, y, x + r, y)
    return s
  }

  /**
   * Canvas texture with printed CPU markings (like real lid text).
   *
   * Only what the Agent actually reported may be printed here. The previous
   * version stamped `SRK2L  3.50GHZ` and `L123B456` - an sSpec code, a clock and
   * a batch serial, all hand-written constants, on a component that is otherwise
   * labelled with the user's real processor (S4 §3.1). A detail view that prints
   * a plausible fake is worse than one that prints less, because it teaches the
   * viewer that this panel's part numbers are trustworthy. Missing line = blank.
   */
  _makeCpuTexture(cpu) {
    const model = typeof cpu === 'string' ? cpu : cpu?.model
    const threads = typeof cpu === 'object' ? cpu?.cores : null
    const physical = typeof cpu === 'object' ? cpu?.cores_physical : null
    const cv = document.createElement('canvas')
    cv.width = 256; cv.height = 256
    const ctx = cv.getContext('2d')
    ctx.clearRect(0, 0, 256, 256)
    ctx.textAlign = 'center'
    ctx.fillStyle = '#4a4a4a'
    ctx.font = 'bold 44px Arial, sans-serif'
    ctx.fillText('CPU', 128, 88)
    ctx.font = '20px Arial, sans-serif'
    ctx.fillStyle = '#5a5a5a'
    const m = (model || 'Processor').slice(0, 24)
    ctx.fillText(m, 128, 124)
    ctx.font = '15px monospace'
    ctx.fillStyle = '#6a6a6a'
    // Reported by the Agent (psutil cpu_count), unlike the sSpec/serial this
    // replaced. Both halves may be absent on an old Agent - then the line stays
    // empty rather than being filled with something that looks like a marking.
    if (threads) {
      ctx.fillText(physical ? `${threads} 线程 · ${physical} 物理核` : `${threads} 线程`, 128, 158)
    }
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  /* ===== MEMORY ===== */

  _buildMemory(mem) {
    if (!mem || !mem.sticks?.length) return
    // MEMORY POOL: real systems interleave addresses across sticks/channels, so
    // per-stick "how much is stored" is NOT meaningful. We show up to 2 containers
    // (channels); both fill to the SAME level = whole-pool usage %.
    const containers = []
    const count = Math.min(mem.sticks.length, 2)
    const tankW = 1.4, tankD = 4.2, tankH = 3.4
    const baseX = 1.0, spacing = 2.2
    const rowZ = CPU_POS.z          // align memory row with CPU
    for (let i = 0; i < count; i++) {
      const group = new THREE.Group()
      const x = baseX + i * spacing
      const z = rowZ
      group.position.set(x, 0, z)

      // Glass vessel (translucent tank)
      const glassMat = new THREE.MeshStandardMaterial({
        color: 0x9fd8ff, roughness: 0.1, metalness: 0.0,
        transparent: true, opacity: 0.22, side: THREE.DoubleSide,
      })
      const glass = new THREE.Mesh(new THREE.BoxGeometry(tankW, tankH, tankD), glassMat)
      glass.position.y = tankH / 2
      group.add(glass)

      // Metal rims (top & bottom)
      const rimMat = new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.4, metalness: 0.6 })
      const rimBot = new THREE.Mesh(new THREE.BoxGeometry(tankW + 0.12, 0.12, tankD + 0.12), rimMat)
      rimBot.position.y = 0.06
      group.add(rimBot)

      // Liquid fill (geometry origin at bottom so scale.y grows upward)
      const fillH = tankH * 0.92
      const fillGeo = new THREE.BoxGeometry(tankW * 0.86, fillH, tankD * 0.86)
      fillGeo.translate(0, fillH / 2, 0)
      const fillMat = new THREE.MeshStandardMaterial({
        // COOLANT, not STRUCT.ram (色表 §6 / 任务书 §6.4-④): this is the colour of
        // a physical fluid, not of "the memory subsystem". Same value, different
        // key — two facts, two names, so the coolant can be re-tuned on its own.
        color: toRGB(COOLANT), roughness: 0.3, metalness: 0.2,
        transparent: true, opacity: 0.75,
        emissive: toRGB(COOLANT), emissiveIntensity: 0.15,
      })
      const fill = new THREE.Mesh(fillGeo, fillMat)
      fill.position.y = 0.12
      fill.scale.y = 0.001
      group.add(fill)

      // Per-container label = this channel's capacity (not per-stick usage)
      const stick = mem.sticks[i]
      const label = this._makeLabel(`${stick?.slot || ('CH' + i)}\n${stick?.size_gb || '?'}GB ${mem.type || ''}`, 'ram-label')
      label.position.set(0, tankH + 1.2, 0)
      group.add(label)

      this.scene.add(group)
      this._registerPickable(group, 'memory')
      containers.push({ group, fill, fillMat, label })
    }

    const centerX = baseX + (count - 1) * spacing / 2
    this._memCenter = { x: centerX, z: rowZ }
    this.components.set('memory', {
      group: null, containers, label: null,
      pos: { x: centerX, z: rowZ }, type: 'memory'
    })
  }

  /* ===== GPU ===== */

  _buildGPU(gpus) {
    gpus.forEach((gpu, i) => {
      const group = new THREE.Group()
      const z = PCIE_START.z + i * PCIE_GAP
      group.position.set(PCIE_START.x, 0, z)

      // PCIe slot (long black slot with gold contacts)
      const slotMat = new THREE.MeshStandardMaterial({ color: C.slot_black, roughness: 0.8 })
      const slot = new THREE.Mesh(new THREE.BoxGeometry(11.5, 0.35, 0.85), slotMat)
      slot.position.y = 0.175
      group.add(slot)
      const contactMat = new THREE.MeshStandardMaterial({ color: C.gold_dark, roughness: 0.3, metalness: 0.8 })
      const contacts = new THREE.Mesh(new THREE.BoxGeometry(11, 0.04, 0.6), contactMat)
      contacts.position.y = 0.36
      group.add(contacts)

      // GPU PCB
      const pcbMat = new THREE.MeshStandardMaterial({
        color: C.gpu_pcb, roughness: 0.6, metalness: 0.2,
        emissive: 0x000000, emissiveIntensity: 0,
      })
      const pcb = new THREE.Mesh(new THREE.BoxGeometry(10.5, 0.18, 1.6), pcbMat)
      pcb.position.y = 0.45
      group.add(pcb)

      // GPU gold fingers (PCIe connector)
      for (let g = 0; g < 16; g++) {
        const finger = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.6), contactMat)
        finger.position.set(-4.8 + g * 0.62, 0.35, 0)
        group.add(finger)
      }

      // Cooler shroud
      const shroudMat = new THREE.MeshStandardMaterial({
        color: C.gpu_shroud, roughness: 0.45, metalness: 0.5,
        emissive: 0x000000, emissiveIntensity: 0,
      })
      const shroud = new THREE.Mesh(new THREE.BoxGeometry(10.2, 1.8, 3.2), shroudMat)
      shroud.position.y = 0.54 + 0.9
      shroud.castShadow = true
      group.add(shroud)

      // Backplate
      const bpMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.4, metalness: 0.6 })
      const bp = new THREE.Mesh(new THREE.BoxGeometry(10.3, 0.08, 3.0), bpMat)
      bp.position.y = 0.5
      group.add(bp)

      // Fans
      const fanMat = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.6 })
      const fans = []
      const fanCount = (gpu.model || '').includes('H100') ? 2 : 3
      for (let f = 0; f < fanCount; f++) {
        const fanGroup = new THREE.Group()
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.06, 8, 20), fanMat)
        ring.rotation.x = Math.PI / 2
        fanGroup.add(ring)
        // Blades
        for (let b = 0; b < 9; b++) {
          const blade = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.03, 0.15), fanMat)
          const a = (b / 9) * Math.PI * 2
          blade.position.set(Math.cos(a) * 0.4, 0, Math.sin(a) * 0.4)
          blade.rotation.y = a + 0.3
          fanGroup.add(blade)
        }
        fanGroup.position.set(-3.2 + f * 3.2, 2.4, 0)
        group.add(fanGroup)
        fans.push(fanGroup)
      }

      // Label
      const text = `${gpu.model}\n${gpu.vram_gb}GB VRAM`
      const label = this._makeLabel(text, 'gpu-label')
      label.position.set(0, 4.0, 0)
      group.add(label)

      this.scene.add(group)
      this._registerPickable(group, gpu.id || `gpu${i}`)
      this.components.set(gpu.id, {
        group, pcbMat, shroudMat, fans, label,
        pos: { x: PCIE_START.x, z }, type: 'gpu', index: i
      })
    })
  }

  /* ===== STORAGE ===== */

  _buildStorage(storageList) {
    storageList.forEach((st, i) => {
      if (!st.interface?.startsWith('M2')) return
      const group = new THREE.Group()
      const x = M2_POS.x + i * 5
      const z = M2_POS.z
      group.position.set(x, 0, z)

      // M.2 slot
      const slotMat = new THREE.MeshStandardMaterial({ color: C.slot_black, roughness: 0.8 })
      const slot = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.25, 0.9), slotMat)
      slot.position.set(-3.5, 0.12, 0)
      group.add(slot)

      // SSD PCB
      const ssdMat = new THREE.MeshStandardMaterial({
        color: C.m2_pcb, roughness: 0.5, metalness: 0.2,
        emissive: 0x000000, emissiveIntensity: 0,
      })
      const ssd = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.12, 0.8), ssdMat)
      ssd.position.y = 0.18
      group.add(ssd)

      // NAND chips on SSD
      const chipMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 })
      for (let c = 0; c < 4; c++) {
        const chip = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.55), chipMat)
        chip.position.set(-2.2 + c * 1.6, 0.28, 0)
        group.add(chip)
      }

      // Gold contacts
      const contactMat = new THREE.MeshStandardMaterial({ color: C.gold, roughness: 0.25, metalness: 0.9 })
      const contact = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.1, 0.6), contactMat)
      contact.position.set(-3.3, 0.18, 0)
      group.add(contact)

      const label = this._makeLabel(`${st.model}\n${st.capacity_tb}TB NVMe`, 'storage-label')
      label.position.set(0, 1.3, 0)
      group.add(label)

      this.scene.add(group)
      this._registerPickable(group, st.id)
      this.components.set(st.id, { group, ssdMat, label, pos: { x, z }, type: 'storage', via: st.via || 'cpu' })
    })
  }

  /* ===== NETWORK ===== */

  _buildNetwork(nics) {
    nics.forEach((nic, i) => {
      const group = new THREE.Group()
      const x = NIC_POS.x, z = NIC_POS.z + i * 2.5
      group.position.set(x, 0, z)

      const nicMat = new THREE.MeshStandardMaterial({
        color: C.nic_pcb, roughness: 0.6, metalness: 0.2,
        emissive: 0x000000, emissiveIntensity: 0,
      })
      const pcb = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.12, 1.2), nicMat)
      pcb.position.y = 0.2
      group.add(pcb)

      // RJ45 / antenna connector
      const connMat = new THREE.MeshStandardMaterial({ color: C.socket_metal, roughness: 0.3, metalness: 0.8 })
      const conn = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.5), connMat)
      conn.position.set(1.3, 0.45, 0)
      group.add(conn)

      // LED indicators
      const ledMat = new THREE.MeshStandardMaterial({ color: 0x00ff00, emissive: 0x00ff00, emissiveIntensity: 0.5 })
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.1, 0.15), ledMat)
      led.position.set(1.3, 0.75, 0.2)
      group.add(led)

      const label = this._makeLabel(`${nic.model}\n${nic.interface}`, 'nic-label')
      label.position.set(0, 1.8, 0)
      group.add(label)

      this.scene.add(group)
      this._registerPickable(group, nic.id)
      this.components.set(nic.id, { group, nicMat, ledMat, label, pos: { x, z }, type: 'network', via: nic.via || 'pch' })
    })
  }

  /* ===== PCH ===== */

  _buildPCH(pch) {
    const group = new THREE.Group()
    group.position.set(PCH_POS.x, 0, PCH_POS.z)

    // BGA chip body
    const pchMat = new THREE.MeshStandardMaterial({ color: C.pch_body, roughness: 0.7, metalness: 0.3 })
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.5, 2.5), pchMat)
    body.position.y = 0.25
    group.add(body)

    // Heatsink on PCH
    const hsMat = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.4, metalness: 0.6 })
    const hs = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.9, 2.3), hsMat)
    hs.position.y = 0.95
    hs.castShadow = true
    group.add(hs)

    // BGA pads underneath (visible gold dots at edges)
    const padMat = new THREE.MeshStandardMaterial({ color: C.gold_dark, roughness: 0.3, metalness: 0.8 })
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 6), padMat)
        pad.position.set(-0.9 + c * 0.45, 0.01, -0.9 + r * 0.45)
        group.add(pad)
      }
    }

    const label = this._makeLabel(`${pch.model}\n(PCH)`, 'pch-label')
    label.position.set(0, 2.8, 0)
    group.add(label)

    this.scene.add(group)
    this.components.set(pch.id || 'pch', { group, pchMat, label, pos: { ...PCH_POS }, type: 'pch' })
  }

  /* ===== PCB TRACE LINKS (Manhattan routing) ===== */

  _buildLinks() {
    const t = this.topology
    const cpuPos = CPU_POS

    if (this._memCenter) this._addTrace(cpuPos, this._memCenter, 'ddr')
    for (const gpu of (t.gpu || [])) {
      const comp = this.components.get(gpu.id)
      if (comp) this._addTrace(cpuPos, comp.pos, 'pcie_x16')
    }
    for (const st of (t.storage || [])) {
      const comp = this.components.get(st.id)
      if (!comp) continue
      const from = comp.via === 'pch' && t.pch ? PCH_POS : cpuPos
      this._addTrace(from, comp.pos, 'pcie_x4')
    }
    if (t.pch) this._addTrace(cpuPos, PCH_POS, 'dmi')
    for (const nic of (t.network || [])) {
      const comp = this.components.get(nic.id)
      if (!comp) continue
      const from = comp.via === 'pcie' ? cpuPos : (t.pch ? PCH_POS : cpuPos)
      this._addTrace(from, comp.pos, comp.via === 'pcie' ? 'pcie_x4' : 'pcie_x1')
    }
  }

  _buildInterconnects(interconnects) {
    for (const ic of interconnects) {
      if (ic.type === 'NVLink' && ic.peers?.length >= 2) {
        for (let i = 0; i < ic.peers.length; i++) {
          for (let j = i + 1; j < ic.peers.length; j++) {
            const a = this.components.get(ic.peers[i])
            const b = this.components.get(ic.peers[j])
            if (a && b) this._addTrace(a.pos, b.pos, 'nvlink')
          }
        }
      }
    }
  }

  /**
   * Add a PCB-style trace: flat copper line with Manhattan routing (right angles).
   * Sits just above the PCB surface like a real copper trace.
   */
  _addTrace(from, to, busType) {
    const style = BUS_STYLE[busType] || BUS_STYLE.pcie_x1
    const y = 0.04  // Just above PCB surface
    const w = style.width
    const h = 0.035 // Trace thickness (copper height)

    const traceMat = new THREE.MeshStandardMaterial({
      color: style.color,
      roughness: 0.35,
      metalness: 0.7,
      emissive: style.color,
      emissiveIntensity: 0.2,
    })

    // Manhattan routing: horizontal first, then vertical
    const dx = to.x - from.x
    const dz = to.z - from.z
    const segments = []

    if (Math.abs(dx) > 0.3) {
      segments.push({ sx: from.x, sz: from.z, ex: to.x, ez: from.z })
    }
    if (Math.abs(dz) > 0.3) {
      segments.push({ sx: to.x, sz: from.z, ex: to.x, ez: to.z })
    }
    // If both are negligible, just draw a dot
    if (!segments.length) return

    const group = new THREE.Group()
    for (const seg of segments) {
      const segDx = seg.ex - seg.sx
      const segDz = seg.ez - seg.sz
      const len = Math.sqrt(segDx * segDx + segDz * segDz)
      if (len < 0.1) continue

      const isHoriz = Math.abs(segDx) > Math.abs(segDz)
      const geo = isHoriz
        ? new THREE.BoxGeometry(len, h, w)
        : new THREE.BoxGeometry(w, h, len)
      const mesh = new THREE.Mesh(geo, traceMat)
      mesh.position.set(
        (seg.sx + seg.ex) / 2,
        y,
        (seg.sz + seg.ez) / 2
      )
      group.add(mesh)
    }

    // Add via pads at corners (where trace changes direction)
    const viaMat = new THREE.MeshStandardMaterial({
      color: style.color, roughness: 0.3, metalness: 0.8,
      emissive: style.color, emissiveIntensity: 0.3,
    })
    // Start pad
    const padStart = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.8, w * 0.8, h + 0.01, 8), viaMat)
    padStart.position.set(from.x, y, from.z)
    group.add(padStart)
    // Corner pad
    if (segments.length > 1) {
      const corner = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.7, w * 0.7, h + 0.01, 8), viaMat)
      corner.position.set(to.x, y, from.z)
      group.add(corner)
    }
    // End pad
    const padEnd = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.8, w * 0.8, h + 0.01, 8), viaMat)
    padEnd.position.set(to.x, y, to.z)
    group.add(padEnd)

    this.scene.add(group)
    this.links.push({ group, mat: traceMat, from, to, type: busType, baseIntensity: 0.2 })
  }

  /* ---------- P4: component picking ---------- */

  _registerPickable(group, key) {
    group.userData.pickKey = key
    this._pickables.push(group)
  }

  /** cb(pickKey) on a click (not drag) that hits a registered component. */
  enableClicks(cb) {
    const el = this.renderer.domElement
    let down = null
    this._onPointerDown = (e) => { down = [e.clientX, e.clientY] }
    this._onPointerUp = (e) => {
      if (!down) return
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1])
      down = null
      if (moved > 5) return
      const rect = el.getBoundingClientRect()
      this._pointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      this._ray.setFromCamera(this._pointer, this.camera)
      const hits = this._ray.intersectObjects(this._pickables, true)
      for (const h of hits) {
        let o = h.object
        while (o && !o.userData.pickKey) o = o.parent
        if (o) { cb(o.userData.pickKey); return }
      }
    }
    el.addEventListener('pointerdown', this._onPointerDown)
    el.addEventListener('pointerup', this._onPointerUp)
  }

  /* ---------- Real-time metrics ---------- */

  updateMetrics(metrics, alarm) {
    if (!metrics) return
    this._metrics = metrics
    // P4: alarm may be a component map {cpu, mem, gpu0, ..., disk} (all CRIT flags),
    // or the legacy boolean (whole-node CRIT -> CPU blinks).
    const map = alarm && typeof alarm === 'object' ? alarm : null

    // CPU - lid color driven by usage + temperature, alarm blink on critical
    const cpuComp = this.components.get('cpu')
    if (cpuComp && metrics.cpu) {
      const usage = metrics.cpu.usage_percent || 0
      const temp = metrics.cpu.temperature_c
      // Blend: temperature has higher weight when available (more critical indicator)
      const tempNorm = temp != null ? Math.min(Math.max((temp - 30) / 70, 0), 1) * 100 : null
      const effective = tempNorm != null ? (usage * 0.4 + tempNorm * 0.6) : usage
      const color = this._loadColor(effective)
      // Alarm: debounced per-component CRIT flags (P4 map), else legacy boolean,
      // else local instant thresholds. Visual blink is applied per-frame in _animate.
      const isAlarm = map ? !!map.cpu
        : (alarm != null ? !!alarm : (usage > 90 || (temp != null && temp > 85)))
      cpuComp._alarm = isAlarm
      if (!isAlarm) {
        cpuComp.ihsMat.emissive.copy(color)
        cpuComp.ihsMat.emissiveIntensity = 0.05 + (effective / 100) * 0.5
      }
      // Label on CPU lid: model (top line) + usage | temp | freq (sub line)
      const el = cpuComp.label.element
      el.querySelector('.tl-sub').textContent =
        `${usage.toFixed(0)}%${temp != null ? ' | ' + temp + '\u00B0C' : ''} | ${metrics.cpu.freq_mhz || '--'}MHz`
      // CSS alarm class for label text blink
      if (isAlarm) el.classList.add('alarm-blink')
      else el.classList.remove('alarm-blink')
    }

    // Memory (pooled containers - both fill to the same pool usage %)
    const memComp = this.components.get('memory')
    if (memComp && metrics.memory) {
      memComp._alarm = map ? !!map.mem : false
      const usage = metrics.memory.percent || 0
      const color = this._loadColor(usage)
      const frac = Math.max(usage / 100, 0.001)
      for (const c of (memComp.containers || [])) {
        c.fill.scale.y = frac
        c.fillMat.color.copy(color).lerp(new THREE.Color(toRGB(COOLANT)), 0.45)
        c.fillMat.emissive.copy(color)
        c.fillMat.emissiveIntensity = 0.1 + (usage / 100) * 0.35
      }
    }

    // GPU
    for (const gpu of (metrics.gpu || [])) {
      const gkey = gpu.id || `gpu${gpu.index}`
      const comp = this.components.get(gpu.id || `gpu${gpu.index}`)
      if (!comp) continue
      comp._alarm = map ? !!map[gkey] : false
      const usage = gpu.usage_percent || 0
      const color = this._loadColor(usage)
      comp.shroudMat.emissive.copy(color)
      comp.shroudMat.emissiveIntensity = 0.05 + (usage / 100) * 0.45
      comp.pcbMat.emissive.copy(color)
      comp.pcbMat.emissiveIntensity = 0.03 + (usage / 100) * 0.25
      for (const fan of (comp.fans || [])) fan.rotation.y += 0.04 + (usage / 100) * 0.22
      // Label
      const el = comp.label.element
      const vramU = gpu.vram_used_mb ? (gpu.vram_used_mb / 1024).toFixed(1) : '?'
      const vramT = gpu.vram_total_mb ? (gpu.vram_total_mb / 1024).toFixed(0) : '?'
      const temp = gpu.temperature_c ? ` | ${gpu.temperature_c}C` : ''
      el.querySelector('.tl-sub').textContent = `${usage}% | ${vramU}/${vramT}GB${temp}`
    }

    // Storage M.2 cards blink with the node's disk CRIT flag (P4)
    for (const comp of this.components.values()) {
      if (comp.type === 'storage') comp._alarm = map ? !!map.disk : false
    }

    // Network
    for (const nic of (this.topology.network || [])) {
      const comp = this.components.get(nic.id)
      if (!comp || !metrics.network) continue
      const mbps = (metrics.network.upload_mbps || 0) + (metrics.network.download_mbps || 0)
      const intensity = Math.min(mbps / 100, 1.0)
      comp.nicMat.emissive.set(0x4caf50)
      comp.nicMat.emissiveIntensity = intensity * 0.5
      if (comp.ledMat) comp.ledMat.emissiveIntensity = 0.3 + intensity * 0.7
      const el = comp.label.element
      el.querySelector('.tl-sub').textContent =
        `D:${(metrics.network.download_mbps || 0).toFixed(1)} U:${(metrics.network.upload_mbps || 0).toFixed(1)} Mbps`
    }

    // Bus traces glow with activity
    for (const link of this.links) {
      if (link.type === 'ddr' && metrics.memory) {
        link.mat.emissiveIntensity = link.baseIntensity + (metrics.memory.percent / 100) * 0.35
      } else if (link.type === 'pcie_x16' && metrics.gpu?.[0]) {
        link.mat.emissiveIntensity = link.baseIntensity + ((metrics.gpu[0].usage_percent || 0) / 100) * 0.35
      }
    }
  }

  _loadColor(percent) {
    if (percent == null) return new THREE.Color(0x455a64)
    if (percent < 50) return new THREE.Color(0x4caf50).lerp(new THREE.Color(0xff9800), percent / 50)
    return new THREE.Color(0xff9800).lerp(new THREE.Color(0xf44336), (percent - 50) / 50)
  }

  /* ---------- Labels ---------- */

  _makeLabel(text, className = '') {
    const div = document.createElement('div')
    div.className = `topo-label ${className}`
    const lines = text.split('\n')
    div.innerHTML = `<div class="tl-name">${lines[0]}</div><div class="tl-sub">${lines[1] || ''}</div>`
    return new CSS2DObject(div)
  }

  /* ---------- Animation ---------- */

  _animate() {
    this._raf = requestAnimationFrame(this._animate)
    const t = this._clock.getElapsedTime()
    // Component-level CRIT blink (P4): red pulse over whatever updateMetrics set
    const blink = (Math.sin(t * 6) + 1) / 2
    for (const comp of this.components.values()) {
      if (!comp._alarm) continue
      const mats = comp.type === 'memory'
        ? (comp.containers || []).map((c) => c.fillMat)
        : [comp.ihsMat, comp.shroudMat, comp.ssdMat].filter(Boolean)
      for (const m of mats) {
        m.emissive.setHex(toRGB(NEUTRAL.alarm))
        m.emissiveIntensity = 0.4 + blink * 0.6
      }
    }
    // Subtle trace shimmer. The previous form fed its own output back into
    // `emissiveIntensity` once per frame with only a lower clamp, so a page left
    // open for a day drifted: the glow was no longer the traffic it encoded
    // (S4 §1.1 rule 1 - a channel that moves on its own is not carrying state).
    // Shimmer is now derived from the value the data set, never accumulated.
    for (const link of this.links) {
      const shimmer = Math.sin(t * 1.2 + link.from.x * 0.5) * 0.04
      const base = link.baseIntensity ?? 0.2
      link.mat.emissiveIntensity = Math.max(0.1, base + shimmer)
    }
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
    this.labelRenderer.render(this.scene, this.camera)
  }

  /* ---------- Cleanup ---------- */

  dispose() {
    cancelAnimationFrame(this._raf)
    this._ro.disconnect()
    if (this._onPointerDown) {
      const el = this.renderer.domElement
      el.removeEventListener('pointerdown', this._onPointerDown)
      el.removeEventListener('pointerup', this._onPointerUp)
    }
    this.controls.dispose()
    this.renderer.dispose()
    const el = this.renderer.domElement
    if (el.parentElement) el.parentElement.removeChild(el)
    const lel = this.labelRenderer.domElement
    if (lel.parentElement) lel.parentElement.removeChild(lel)
  }
}

export { BUS_STYLE, C as COMP_COLOR }
