"""Memory metric collector - psutil + platform-specific stick info."""
import json

import psutil
import platform
import subprocess

_sticks_cache = None  # DIMM layout is static; probe once per process


def collect():
    """Collect memory metrics: total, used, percent, and per-stick info."""
    vm = psutil.virtual_memory()
    data = {
        "total_gb": round(vm.total / (1024**3), 2),
        "used_gb": round(vm.used / (1024**3), 2),
        "percent": vm.percent,
        "available_gb": round(vm.available / (1024**3), 2),
        "sticks": _collect_sticks(),
    }
    return data


def _collect_sticks():
    """Detect individual memory sticks (DIMM info), cached."""
    global _sticks_cache
    if _sticks_cache is not None:
        return _sticks_cache
    system = platform.system()
    sticks = []

    if system == "Windows":
        # wmic is gone on Win11 24H2+ -> CIM via PowerShell, JSON to avoid locale parsing
        try:
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "(Get-CimInstance Win32_PhysicalMemory "
                 "| Select-Object DeviceLocator,Capacity,Speed | ConvertTo-Json -Compress)"],
                capture_output=True, text=True, timeout=15,
            )
            txt = result.stdout.strip()
            if txt.startswith("[") or txt.startswith("{"):
                rows = json.loads(txt)
                if isinstance(rows, dict):
                    rows = [rows]
                for r in rows:
                    cap = r.get("Capacity")
                    if not cap:
                        continue
                    sticks.append({
                        "slot": r.get("DeviceLocator") or f"DIMM_{len(sticks)}",
                        "size_gb": round(cap / (1024**3), 1),
                        "freq_mhz": r.get("Speed") or None,
                    })
        except Exception:
            pass

    elif system == "Linux":
        try:
            result = subprocess.run(
                ["sudo", "dmidecode", "-t", "memory"],
                capture_output=True, text=True, timeout=5,
            )
            # Parse dmidecode output for memory devices
            current = {}
            for line in result.stdout.split("\n"):
                line = line.strip()
                if line.startswith("Locator:"):
                    current["slot"] = line.split(":", 1)[1].strip()
                elif line.startswith("Size:") and "No Module" not in line:
                    size_str = line.split(":", 1)[1].strip()
                    try:
                        if "GB" in size_str:
                            current["size_gb"] = float(size_str.replace("GB", "").strip())
                        elif "MB" in size_str:
                            current["size_gb"] = round(float(size_str.replace("MB", "").strip()) / 1024, 1)
                    except ValueError:
                        pass
                elif line.startswith("Speed:") and "Unknown" not in line:
                    speed_str = line.split(":", 1)[1].strip()
                    try:
                        current["freq_mhz"] = int(speed_str.replace("MHz", "").replace("MT/s", "").strip())
                    except ValueError:
                        pass
                elif line == "" and current.get("slot") and current.get("size_gb"):
                    sticks.append(current)
                    current = {}
            if current.get("slot") and current.get("size_gb"):
                sticks.append(current)
        except Exception:
            pass

    _sticks_cache = sticks
    return sticks
