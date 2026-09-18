"""
Host Monitor Agent
==================
Collects hardware metrics + topology and pushes to central server via WebSocket.

Usage:
    python main.py [--server ws://192.168.1.100:9100] [--interval 2] [--host-id my-pc]
"""
import argparse
import asyncio
import json
import platform
import socket
import time
import uuid

import websockets

from collectors import cpu, disk, gpu, memory, network, system
from collectors.topology import detect_topology
from prober import Prober

ROLES = ("db", "inference", "desktop", "laptop", "display", "other")


def get_default_host_id():
    """Generate a stable host identifier from hostname."""
    hostname = socket.gethostname()
    host_id = hostname.lower().replace(" ", "-")
    host_id = "".join(c for c in host_id if c.isalnum() or c == "-")
    return host_id or f"host-{uuid.uuid4().hex[:8]}"


def collect_all():
    """Run all collectors and assemble a full metrics frame."""
    frame = {
        "host_id": ARGS.host_id,
        "hostname": socket.gethostname(),
        "platform": f"{platform.system()} {platform.release()}",
        "timestamp": int(time.time() * 1000),
        "cpu": cpu.collect(),
        "gpu": gpu.collect(),
        "memory": memory.collect(),
        "network": network.collect(),
        "disk": disk.collect(),
        "system": system.collect(),
    }
    return frame


async def run_agent(server_url, interval):
    """Main agent loop: connect, register with topology, then stream metrics."""
    print(f"[Agent] Host ID:  {ARGS.host_id}")
    print(f"[Agent] Server:   {server_url}")
    print(f"[Agent] Interval: {interval}s")

    # Detect hardware topology once at startup
    print(f"[Agent] Detecting hardware topology...")
    topo = detect_topology()
    print(f"[Agent] Topology: {topo['cpu']['model']}, "
          f"{len(topo['memory']['sticks'])} DIMM, "
          f"{len(topo['gpu'])} GPU, "
          f"{len(topo['storage'])} Storage")

    print(f"[Agent] Connecting...")

    ws_ref = {"ws": None}           # shared with prober: current connection or None
    prober = Prober(ws_ref)

    while True:
        try:
            async with websockets.connect(server_url) as ws:
                ws_ref["ws"] = ws
                prober.reset_target("server")  # fresh window after (re)connect
                print(f"[Agent] Connected to {server_url}")

                # Send registration with topology
                await ws.send(json.dumps({
                    "type": "register",
                    "host_id": ARGS.host_id,
                    "hostname": socket.gethostname(),
                    "platform": f"{platform.system()} {platform.release()}",
                    "role": ARGS.role,
                    "topology": topo,
                }))

                # Registered ack carries the probe plan (P3). Old servers
                # without it just leave us probing the Server arm only.
                try:
                    ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                    plan = ack.get("probe_plan")
                    prober.apply_plan(plan)
                    if plan:
                        print(f"[Agent] Probe plan: "
                              f"{', '.join(t['id'] for t in prober._targets)}")
                except (asyncio.TimeoutError, json.JSONDecodeError) as e:
                    print(f"[Agent] No probe plan received ({e}); server-only probing")
                prober.start()

                # Stream metrics (probe results ride along)
                while True:
                    frame = collect_all()
                    frame["type"] = "metrics"
                    frame["probes"] = prober.snapshot()
                    await ws.send(json.dumps(frame))
                    await asyncio.sleep(interval)

        except (websockets.exceptions.ConnectionClosed, ConnectionRefusedError, OSError) as e:
            ws_ref["ws"] = None
            print(f"[Agent] Connection lost: {e}. Retrying in 5s...")
            await asyncio.sleep(5)
        except Exception as e:
            ws_ref["ws"] = None
            print(f"[Agent] Error: {e}. Retrying in 5s...")
            await asyncio.sleep(5)


ARGS = None


def main():
    global ARGS
    parser = argparse.ArgumentParser(description="Host Monitor Agent")
    parser.add_argument("--server", default="ws://localhost:9100",
                        help="WebSocket server URL")
    parser.add_argument("--interval", type=float, default=2.0,
                        help="Collection interval in seconds")
    parser.add_argument("--host-id", default=None,
                        help="Custom host identifier")
    parser.add_argument("--role", default="other", choices=ROLES,
                        help="Node role tag (affects overview ordering)")
    ARGS = parser.parse_args()

    if not ARGS.host_id:
        ARGS.host_id = get_default_host_id()

    try:
        asyncio.run(run_agent(ARGS.server, ARGS.interval))
    except KeyboardInterrupt:
        print("\n[Agent] Stopped.")
    finally:
        gpu.shutdown()


if __name__ == "__main__":
    main()
