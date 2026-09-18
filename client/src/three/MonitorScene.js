import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

/**
 * Host Monitor 3D Digital Twin Scene
 * ===================================
 * Renders procedural server/host models in a grid layout.
 * Each host shows real-time metrics via CSS2D labels.
 * Status color coding: green=normal, orange=warning, red=critical, gray=offline.
 */

/* ---------------- Constants ---------------- */

const STATUS_COLORS = {
  online: 0x4caf50,
  warning: 0xff9800,
  critical: 0xf44336,
  offline: 0x757575,
}

const HOST_SIZE = { w: 3.2, h: 4.5, d: 2.0 }
const GRID_GAP = 6.0
const LABEL_HEIGHT = 3.6

/* ---------------- Main Scene Class ---------------- */

export class MonitorScene {
  constructor(container) {
    this.container = container
    this.hosts = new Map()       // host_id -> { group, mesh, label, data, statusColor }
    this.selectedId = null
    this.onSelect = null         // (hostId | null) => void
    this.onHover = null          // (hostId | null, x?, y?) => void
    this._clock = new THREE.Clock()
    this._pickables = []

    this._initRenderer()
    this._initScene()
    this._initEvents()

    this._animate = this._animate.bind(this)
    this._raf = requestAnimationFrame(this._animate)
  }

  /* ---------------- Initialization ---------------- */

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.container.appendChild(this.renderer.domElement)

    this.labelRenderer = new CSS2DRenderer()
    const ld = this.labelRenderer.domElement
    ld.style.position = 'absolute'
    ld.style.top = '0'
    ld.style.left = '0'
    ld.style.pointerEvents = 'none'
    ld.style.zIndex = '2'
    this.container.appendChild(ld)
  }

  _initScene() {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('#1a1d23')

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      50,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      500,
    )
    this.camera.position.set(12, 10, 18)

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 2, 0)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxPolarAngle = Math.PI * 0.48
    this.controls.minDistance = 5
    this.controls.maxDistance = 80

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.4)
    this.scene.add(ambient)

    const mainLight = new THREE.DirectionalLight(0xffffff, 1.2)
    mainLight.position.set(10, 20, 15)
    mainLight.castShadow = true
    mainLight.shadow.mapSize.set(2048, 2048)
    mainLight.shadow.camera.near = 1
    mainLight.shadow.camera.far = 60
    mainLight.shadow.camera.left = -20
    mainLight.shadow.camera.right = 20
    mainLight.shadow.camera.top = 20
    mainLight.shadow.camera.bottom = -20
    this.scene.add(mainLight)

    const fillLight = new THREE.DirectionalLight(0x8ecae6, 0.4)
    fillLight.position.set(-8, 6, -10)
    this.scene.add(fillLight)

    // Ground plane (grid)
    const gridHelper = new THREE.GridHelper(60, 60, 0x333844, 0x262a33)
    this.scene.add(gridHelper)

    const groundGeo = new THREE.PlaneGeometry(60, 60)
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x1e2128,
      roughness: 0.9,
      metalness: 0.1,
    })
    const ground = new THREE.Mesh(groundGeo, groundMat)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.01
    ground.receiveShadow = true
    this.scene.add(ground)

    // Selection ring
    const ringGeo = new THREE.RingGeometry(2.2, 2.6, 48)
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x64b5f6,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    })
    this.selRing = new THREE.Mesh(ringGeo, ringMat)
    this.selRing.rotation.x = -Math.PI / 2
    this.selRing.position.y = 0.05
    this.selRing.visible = false
    this.scene.add(this.selRing)
  }

  _initEvents() {
    this._onResize = () => {
      const w = this.container.clientWidth
      const h = this.container.clientHeight
      if (w === 0 || h === 0) return
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(w, h)
      this.labelRenderer.setSize(w, h)
    }
    this._ro = new ResizeObserver(this._onResize)
    this._ro.observe(this.container)

    this._raycaster = new THREE.Raycaster()
    this._pointer = new THREE.Vector2()
    this._downPos = { x: 0, y: 0 }
    this._ptrDown = false

    const dom = this.renderer.domElement
    this._onDown = (e) => {
      this._ptrDown = true
      this._downPos = { x: e.clientX, y: e.clientY }
    }
    this._onUp = (e) => {
      this._ptrDown = false
      const dx = e.clientX - this._downPos.x
      const dy = e.clientY - this._downPos.y
      if (Math.hypot(dx, dy) > 6) return
      // Raycast click
      const rect = dom.getBoundingClientRect()
      this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      this._raycaster.setFromCamera(this._pointer, this.camera)
      const hits = this._raycaster.intersectObjects(this._pickables, true)
      if (hits.length > 0) {
        const hostId = this._findHostId(hits[0].object)
        if (hostId) {
          this.select(hostId)
          if (this.onSelect) this.onSelect(hostId)
          return
        }
      }
      // Click on empty space: deselect
      this.deselect()
      if (this.onSelect) this.onSelect(null)
    }
    this._onMove = (e) => {
      if (this._ptrDown) return
      const rect = dom.getBoundingClientRect()
      this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      this._raycaster.setFromCamera(this._pointer, this.camera)
      const hits = this._raycaster.intersectObjects(this._pickables, true)
      if (hits.length > 0) {
        const hostId = this._findHostId(hits[0].object)
        if (hostId && this.onHover) this.onHover(hostId, e.clientX, e.clientY)
        dom.style.cursor = hostId ? 'pointer' : 'default'
        return
      }
      dom.style.cursor = 'default'
      if (this.onHover) this.onHover(null)
    }

    dom.addEventListener('pointerdown', this._onDown)
    dom.addEventListener('pointerup', this._onUp)
    dom.addEventListener('pointermove', this._onMove)
  }

  _findHostId(obj) {
    let cur = obj
    while (cur) {
      if (cur.userData && cur.userData.hostId) return cur.userData.hostId
      cur = cur.parent
    }
    return null
  }

  /* ---------------- Host Management ---------------- */

  /**
   * Sync hosts from server data. Creates/removes 3D objects as needed.
   * @param {Array} hostList - Array of host records from server
   */
  syncHosts(hostList) {
    const incomingIds = new Set(hostList.map(h => h.host_id))

    // Remove hosts no longer present
    for (const [id, record] of this.hosts) {
      if (!incomingIds.has(id)) {
        this._removeHost(id)
      }
    }

    // Add or update hosts
    const total = hostList.length
    hostList.forEach((hostData, index) => {
      const id = hostData.host_id
      if (!this.hosts.has(id)) {
        this._createHost(id, index, total)
      }
      this._updateHost(id, hostData, index, total)
    })

    // Re-layout if count changed
    this._relayout(total)
  }

  _createHost(hostId, index, total) {
    const group = new THREE.Group()
    group.userData.hostId = hostId

    // Server body - procedural geometry (rounded box approximation)
    const bodyGeo = new THREE.BoxGeometry(HOST_SIZE.w, HOST_SIZE.h, HOST_SIZE.d, 2, 2, 2)
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x2d3748,
      roughness: 0.4,
      metalness: 0.6,
    })
    const body = new THREE.Mesh(bodyGeo, bodyMat)
    body.position.y = HOST_SIZE.h / 2
    body.castShadow = true
    body.receiveShadow = true
    body.userData.hostId = hostId
    group.add(body)

    // Front panel details (LED strip)
    const ledGeo = new THREE.BoxGeometry(HOST_SIZE.w * 0.7, 0.12, 0.05)
    const ledMat = new THREE.MeshBasicMaterial({ color: STATUS_COLORS.online })
    const led = new THREE.Mesh(ledGeo, ledMat)
    led.position.set(0, HOST_SIZE.h * 0.85, HOST_SIZE.d / 2 + 0.03)
    led.userData.hostId = hostId
    group.add(led)

    // Ventilation grille (visual detail)
    for (let i = 0; i < 5; i++) {
      const ventGeo = new THREE.BoxGeometry(HOST_SIZE.w * 0.6, 0.06, 0.04)
      const ventMat = new THREE.MeshStandardMaterial({ color: 0x1a202c, roughness: 0.8 })
      const vent = new THREE.Mesh(ventGeo, ventMat)
      vent.position.set(0, 0.8 + i * 0.35, HOST_SIZE.d / 2 + 0.02)
      vent.userData.hostId = hostId
      group.add(vent)
    }

    // CSS2D Label
    const labelDiv = document.createElement('div')
    labelDiv.className = 'host-label'
    labelDiv.innerHTML = `
      <div class="hl-name">Loading...</div>
      <div class="hl-metrics">
        <span class="hl-cpu">CPU: --</span>
        <span class="hl-gpu">GPU: --</span>
        <span class="hl-ram">RAM: --</span>
        <span class="hl-net">NET: --</span>
      </div>
    `
    const labelObj = new CSS2DObject(labelDiv)
    labelObj.position.set(0, HOST_SIZE.h + LABEL_HEIGHT, 0)
    group.add(labelObj)

    this.scene.add(group)
    this._pickables.push(body)

    this.hosts.set(hostId, {
      group,
      body,
      bodyMat,
      led,
      ledMat,
      labelDiv,
      labelObj,
      data: null,
      status: 'offline',
    })
  }

  _removeHost(hostId) {
    const record = this.hosts.get(hostId)
    if (!record) return
    this.scene.remove(record.group)
    record.body.geometry.dispose()
    record.bodyMat.dispose()
    // Remove from pickables
    const idx = this._pickables.indexOf(record.body)
    if (idx >= 0) this._pickables.splice(idx, 1)
    this.hosts.delete(hostId)
    if (this.selectedId === hostId) this.deselect()
  }

  _updateHost(hostId, hostData, index, total) {
    const record = this.hosts.get(hostId)
    if (!record) return

    record.data = hostData

    // Determine status
    const metrics = hostData.metrics
    const online = hostData.online
    let status = 'offline'
    if (online && metrics) {
      const cpuUsage = metrics.cpu?.usage_percent || 0
      const gpuUsage = metrics.gpu?.[0]?.usage_percent || 0
      const memUsage = metrics.memory?.percent || 0
      if (cpuUsage > 90 || memUsage > 90 || gpuUsage > 95) {
        status = 'critical'
      } else if (cpuUsage > 70 || memUsage > 75 || gpuUsage > 80) {
        status = 'warning'
      } else {
        status = 'online'
      }
    }
    record.status = status

    // Update color
    const color = STATUS_COLORS[status]
    record.ledMat.color.setHex(color)
    record.bodyMat.emissive = new THREE.Color(color)
    record.bodyMat.emissiveIntensity = status === 'offline' ? 0.02 : 0.08

    // Update label
    const nameEl = record.labelDiv.querySelector('.hl-name')
    const cpuEl = record.labelDiv.querySelector('.hl-cpu')
    const gpuEl = record.labelDiv.querySelector('.hl-gpu')
    const ramEl = record.labelDiv.querySelector('.hl-ram')
    const netEl = record.labelDiv.querySelector('.hl-net')

    nameEl.textContent = hostData.hostname || hostId
    nameEl.style.color = '#' + color.toString(16).padStart(6, '0')

    if (metrics && online) {
      cpuEl.textContent = `CPU: ${metrics.cpu?.usage_percent?.toFixed(1) || 0}%`
      const gpuCount = metrics.gpu?.length || 0
      const gpuUsage = gpuCount > 0 ? metrics.gpu[0].usage_percent : null
      gpuEl.textContent = gpuUsage !== null ? `GPU: ${gpuUsage}%` : 'GPU: N/A'
      ramEl.textContent = `RAM: ${metrics.memory?.percent?.toFixed(1) || 0}%`
      const up = metrics.network?.upload_mbps || 0
      const down = metrics.network?.download_mbps || 0
      netEl.textContent = `NET: ${down.toFixed(1)}/${up.toFixed(1)} Mb`
    } else {
      cpuEl.textContent = 'CPU: --'
      gpuEl.textContent = 'GPU: --'
      ramEl.textContent = 'RAM: --'
      netEl.textContent = 'NET: --'
    }

    // Status class for CSS styling
    record.labelDiv.className = `host-label status-${status}`
  }

  _relayout(total) {
    // Grid layout: arrange hosts in rows
    const cols = Math.ceil(Math.sqrt(total))
    let i = 0
    for (const [id, record] of this.hosts) {
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = (col - (cols - 1) / 2) * GRID_GAP
      const z = (row - (Math.ceil(total / cols) - 1) / 2) * GRID_GAP
      record.group.position.set(x, 0, z)
      i++
    }
  }

  /* ---------------- Selection ---------------- */

  select(hostId) {
    this.selectedId = hostId
    const record = this.hosts.get(hostId)
    if (record) {
      const pos = record.group.position
      this.selRing.position.set(pos.x, 0.05, pos.z)
      this.selRing.visible = true
    }
  }

  deselect() {
    this.selectedId = null
    this.selRing.visible = false
  }

  focusHost(hostId) {
    const record = this.hosts.get(hostId)
    if (!record) return
    const pos = record.group.position
    this.controls.target.set(pos.x, HOST_SIZE.h / 2, pos.z)
    this.camera.position.set(pos.x + 8, 8, pos.z + 10)
  }

  /* ---------------- Animation Loop ---------------- */

  _animate() {
    this._raf = requestAnimationFrame(this._animate)
    const t = this._clock.getElapsedTime()

    // Selection ring pulse
    if (this.selRing.visible) {
      const s = 1 + 0.06 * Math.sin(t * 3.5)
      this.selRing.scale.set(s, s, 1)
      this.selRing.material.opacity = 0.5 + 0.3 * Math.sin(t * 3.5)
    }

    // Subtle LED blink for online hosts
    for (const [id, record] of this.hosts) {
      if (record.status === 'online') {
        const pulse = 0.7 + 0.3 * Math.sin(t * 2 + id.length)
        record.ledMat.color.setHex(STATUS_COLORS.online)
        record.led.scale.x = pulse
      } else if (record.status === 'critical') {
        const blink = Math.sin(t * 6) > 0 ? 1.0 : 0.3
        record.ledMat.color.setHex(STATUS_COLORS.critical)
        record.ledMat.opacity = blink
      }
    }

    this.controls.update()
    this.renderer.render(this.scene, this.camera)
    this.labelRenderer.render(this.scene, this.camera)
  }

  /* ---------------- Cleanup ---------------- */

  dispose() {
    cancelAnimationFrame(this._raf)
    this._ro.disconnect()
    const dom = this.renderer.domElement
    dom.removeEventListener('pointerdown', this._onDown)
    dom.removeEventListener('pointerup', this._onUp)
    dom.removeEventListener('pointermove', this._onMove)
    this.controls.dispose()
    this.renderer.dispose()
    if (dom.parentElement) dom.parentElement.removeChild(dom)
    const ldom = this.labelRenderer.domElement
    if (ldom.parentElement) ldom.parentElement.removeChild(ldom)
  }
}

export { STATUS_COLORS }
