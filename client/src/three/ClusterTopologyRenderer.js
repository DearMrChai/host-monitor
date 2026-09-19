import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

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

const LC = { OK: 0x3fb950, WARN: 0xd29922, CRIT: 0xf85149, OFFLINE: 0x9aa0a6 }
const GRAY = 0xbdb5a6
/* Presentation-only: an ephemeral node that left. Lighter than OFFLINE because
   it carries no alarm (S1 §3.2 — deliberately not a fifth status level). */
const ABSENT = 0xd8d2c6

const HUB_POS = new THREE.Vector3(0, 1.1, 0)
const GW_POS = new THREE.Vector3(3.4, 0.6, 0)

export class ClusterTopologyRenderer {
  constructor(container) {
    this.container = container
    this.nodes = new Map()   // host_id -> { group, bodyMat, baseMat, labelEl, pos }
    this.stubs = new Map()   // target id -> { group, pos } for unmatched probe targets
    this.edges = []          // { line, mat, pulse, from, to, rtt, phase }
    this._edgeSig = ''
    this._clock = new THREE.Clock()
    this._downPt = null
    this.onNodeClick = null  // (hostId) => void

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
    this.scene.background = new THREE.Color('#f5f0e6')

    this.camera = new THREE.PerspectiveCamera(
      42, (this.container.clientWidth || 800) / (this.container.clientHeight || 600), 0.1, 200)
    this.camera.position.set(0, 16, 21)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 1, 0)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxPolarAngle = Math.PI * 0.47
    this.controls.minDistance = 8
    this.controls.maxDistance = 45
    this.controls.enablePan = false

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75))
    const key = new THREE.DirectionalLight(0xfff5e0, 0.9)
    key.position.set(8, 18, 10)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xddeeff, 0.35)
    fill.position.set(-10, 8, -8)
    this.scene.add(fill)

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(13, 48).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xefe8d9, roughness: 1 }))
    ground.position.y = -0.05
    this.scene.add(ground)
    const grid = new THREE.GridHelper(24, 24, 0xd8cfbe, 0xe4dccb)
    grid.position.y = 0
    this.scene.add(grid)

    this._onResize()
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
   * nodes: [{ id, name, deviceLevel, linkLevel, online, absent,
   *           links: [{ key, name, rtt, loss, level }] }]
   */
  update(nodes) {
    this._nodeList = nodes
    const ids = new Set(nodes.map(n => n.id))
    for (const [id, n] of this.nodes) {
      if (!ids.has(id)) { this.scene.remove(n.group); this.nodes.delete(id) }
    }

    // stable ring layout (caller pre-sorts for deterministic order)
    const R = Math.max(6.5, nodes.length * 2.3)
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
      rec.bodyMat.color.setHex(devColor)
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
    const bodyMat = new THREE.MeshStandardMaterial({ color: LC.OK, roughness: 0.55, flatShading: true })
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

  /* ---------- edges ---------- */

  _endpointOf(link, byId) {
    if (link.key === 'server') return { pos: HUB_POS.clone().setY(HUB_POS.y + 1.2), name: 'server' }
    if (link.key === 'gateway') return { pos: GW_POS.clone().setY(GW_POS.y + 0.6), name: 'gw' }
    const targetNode = byId.get(link.key)
    if (targetNode) return { pos: targetNode.pos.clone().setY(1.3), name: link.key }
    // unmatched key host -> small stub behind the gateway
    let stub = this.stubs.get(link.key)
    if (!stub) {
      const idx = this.stubs.size
      const p = new THREE.Vector3(-4.2 - idx * 2.2, 0.35, -3.2)
      stub = this._makeBlock(`${link.name}\n关键节点`, p, 1.0, 0.7, 1.0, 0xa89f8d)
      this.stubs.set(link.key, stub)
    }
    return { pos: stub.group.position.clone().setY(1.0), name: link.key }
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

    for (const n of nodes) {
      const rec = this.nodes.get(n.id)
      if (!rec || !n.online) continue
      const from = rec.pos.clone().setY(1.45)
      for (const l of n.links) {
        const ep = this._endpointOf(l, byId)
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
  }

  _clearEdges() {
    for (const e of this.edges) {
      this.scene.remove(e.line)
      e.line.geometry.dispose()
      e.mat.dispose()
      if (e.pulse) {
        this.scene.remove(e.pulse)
        e.pulse.geometry.dispose()
        e.pulse.material.dispose()
      }
    }
    this.edges = []
  }

  /* ---------- picking ---------- */

  enableClicks() {
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
    const t = this._clock.getElapsedTime()
    for (const e of this.edges) {
      if (!e.pulse) continue
      const f = (e.speed * t + e.phase) % 1
      e.pulse.position.lerpVectors(e.from, e.to, f)
      const s = 0.7 + Math.sin(f * Math.PI) * 0.6   // fade at ends via scale, cheap
      e.pulse.scale.setScalar(Math.max(0.25, s))
    }
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
    this.labelRenderer.render(this.scene, this.camera)
  }

  dispose() {
    cancelAnimationFrame(this._raf)
    this._ro.disconnect()
    this._clearEdges()
    if (this._onDown) {
      this.renderer.domElement.removeEventListener('pointerdown', this._onDown)
      this.renderer.domElement.removeEventListener('pointerup', this._onUp)
    }
    this.controls.dispose()
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
