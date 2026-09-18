# LAN Host Monitor - 3D Digital Twin

局域网主机监控系统，基于 3D 数字孪生可视化。实时监控局域网内各主机的 CPU、GPU（多卡）、内存（多条）、网络速度等硬件指标。

## Architecture

```
[Host A: Python Agent] --+
[Host B: Python Agent] --+-- WebSocket --> [Node.js Server] -- WebSocket --> [Vue3 + Three.js Client]
[Host C: Python Agent] --+                  (relay/aggregate)                (3D Digital Twin Dashboard)
```

## Quick Start

### Prerequisites

- Python 3.9+
- Node.js 18+
- (Optional) NVIDIA GPU + drivers for GPU monitoring

### 1. Start the Server

```bash
cd server
npm install
npm run dev
```

Server will listen on:
- `ws://0.0.0.0:9100` - Agent WebSocket endpoint
- `http://0.0.0.0:9101` - Client REST API + WebSocket

### 2. Start the Frontend

```bash
cd client
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

### 3. Start the Agent (on each monitored host)

```bash
cd agent
pip install -r requirements.txt
python main.py --server ws://<SERVER_IP>:9100
```

For local testing:
```bash
python main.py --server ws://localhost:9100
```

### Agent Options

| Flag | Default | Description |
|------|---------|-------------|
| `--server` | `ws://localhost:9100` | Server WebSocket URL |
| `--interval` | `2` | Collection interval (seconds) |
| `--host-id` | auto (hostname) | Custom host identifier |

## Project Structure

```
host-monitor/
+-- agent/              Python monitoring agent (deploy on each host)
|   +-- main.py         Agent entry point
|   +-- collectors/     Hardware metric collectors (CPU, GPU, RAM, Net)
|   +-- requirements.txt
+-- server/             Node.js central relay server
|   +-- src/index.js    HTTP + WebSocket server
|   +-- src/store.js    In-memory host data store
|   +-- package.json
+-- client/             Vue 3 + Three.js 3D dashboard
|   +-- src/App.vue     Main interface
|   +-- src/three/MonitorScene.js   3D scene renderer
|   +-- src/style.css   Dark theme styles
|   +-- package.json
+-- README.md
```

## Monitored Metrics

- **CPU**: Usage %, core count, frequency, temperature
- **GPU**: Per-card usage %, VRAM used/total, temperature (NVIDIA via pynvml)
- **Memory**: Total/used/available, per-stick info (slot, size, frequency)
- **Network**: Upload/download speed (Mbps), total transferred

## Development Roadmap

- [x] Phase 1: Project scaffolding
- [x] Phase 2: Python Agent (CPU/GPU/RAM/Net collectors)
- [x] Phase 3: Node.js relay server
- [x] Phase 4: 3D frontend visualization (single host demo)
- [ ] Phase 5: Multi-host expansion & auto-discovery
- [ ] Phase 6: Historical data & charts
- [ ] Phase 7: Alert thresholds & notifications
