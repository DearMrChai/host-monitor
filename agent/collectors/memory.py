"""Memory metric collector - psutil + platform-specific stick info."""
import psutil
import platform
import subprocess


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
    """Detect individual memory sticks (DIMM info)."""
    system = platform.system()
    sticks = []

    if system == "Windows":
        try:
            result = subprocess.run(
                ["wmic", "memorychip", "get",
                 "BankLabel,Capacity,Speed,Manufacturer,PartNumber"],
                capture_output=True, text=True, timeout=5,
            )
            lines = [l.strip() for l in result.stdout.strip().split("\n") if l.strip()]
            if len(lines) > 1:
                # Parse header
                headers = [h.strip() for h in lines[0].split()]
                for line in lines[1:]:
                    parts = line.split()
                    if len(parts) >= 3:
                        try:
                            stick = {
                                "slot": parts[0] if parts[0] != "" else f"DIMM_{len(sticks)}",
                                "size_gb": round(int(parts[1]) / (1024**3), 1) if parts[1].isdigit() else None,
                                "freq_mhz": int(parts[-1]) if parts[-1].isdigit() else None,
                            }
                            sticks.append(stick)
                        except (ValueError, IndexError):
                            pass
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

    return sticks
