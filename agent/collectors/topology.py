"""Hardware topology detector - identifies components and their connections.

Uses PowerShell CIM queries on Windows (wmic is deprecated/removed on Win11+).
Uses /proc and dmidecode on Linux.
"""
import json
import platform
import subprocess
import psutil


def _run_powershell(cmd, timeout=8):
    """Run a PowerShell command and return parsed JSON output."""
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", cmd],
            capture_output=True, text=True, timeout=timeout,
        )
        output = result.stdout.strip()
        if not output:
            return None
        return json.loads(output)
    except Exception:
        return None


def detect_topology():
    """Detect the hardware topology of this machine."""
    system = platform.system()
    topo = {
        "host_type": _guess_host_type(system),
        "cpu": _detect_cpu(system),
        "memory": _detect_memory(system),
        "gpu": _detect_gpu(system),
        "storage": _detect_storage(system),
        "network": _detect_network(system),
        "pch": None,
        "interconnects": [],
    }
    return topo


def _guess_host_type(system):
    """Guess if this is a laptop, desktop, or server."""
    try:
        bat = psutil.sensors_battery()
        if bat is not None:
            return "laptop"
    except (AttributeError, Exception):
        pass
    cores = psutil.cpu_count(logical=True) or 4
    if cores >= 32:
        return "server"
    return "desktop"


def _detect_cpu(system):
    """Detect CPU model and specs."""
    model = "Unknown CPU"

    if system == "Windows":
        data = _run_powershell(
            "(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed | ConvertTo-Json)"
        )
        if data:
            if isinstance(data, list):
                data = data[0]
            model = data.get("Name", model)
            return {
                "id": "cpu0",
                "model": model,
                "cores": data.get("NumberOfLogicalProcessors") or psutil.cpu_count(logical=True),
                "cores_physical": data.get("NumberOfCores") or psutil.cpu_count(logical=False),
                "freq_mhz": data.get("MaxClockSpeed"),
            }

    elif system == "Linux":
        try:
            with open("/proc/cpuinfo") as f:
                for line in f:
                    if line.startswith("model name"):
                        model = line.split(":", 1)[1].strip()
                        break
        except Exception:
            pass

    freq = psutil.cpu_freq()
    return {
        "id": "cpu0",
        "model": model,
        "cores": psutil.cpu_count(logical=True) or 4,
        "cores_physical": psutil.cpu_count(logical=False) or 4,
        "freq_mhz": round(freq.current) if freq else None,
    }


def _detect_memory(system):
    """Detect memory configuration (sticks, type, speed)."""
    vm = psutil.virtual_memory()
    total_gb = round(vm.total / (1024**3), 1)
    sticks = []
    mem_type = "DDR4"

    if system == "Windows":
        data = _run_powershell(
            "Get-CimInstance Win32_PhysicalMemory | Select-Object BankLabel,DeviceLocator,Capacity,Speed,SMBIOSMemoryType | ConvertTo-Json"
        )
        if data:
            if not isinstance(data, list):
                data = [data]
            for i, item in enumerate(data):
                capacity = item.get("Capacity", 0)
                speed = item.get("Speed", 0)
                smbios_type = item.get("SMBIOSMemoryType", 0)
                slot = item.get("DeviceLocator") or item.get("BankLabel") or f"DIMM_{i}"

                if capacity and capacity > 0:
                    size_gb = round(capacity / (1024**3))
                    sticks.append({
                        "slot": slot,
                        "size_gb": size_gb,
                        "freq_mhz": speed if speed > 0 else 2666,
                    })
                    # SMBIOSMemoryType: 24=DDR3, 26=DDR4, 34=DDR5
                    if smbios_type == 34:
                        mem_type = "DDR5"
                    elif smbios_type == 26:
                        mem_type = "DDR4"
                    elif smbios_type == 24:
                        mem_type = "DDR3"

    elif system == "Linux":
        try:
            result = subprocess.run(
                ["sudo", "dmidecode", "-t", "memory"],
                capture_output=True, text=True, timeout=5,
            )
            current = {}
            for line in result.stdout.split("\n"):
                line = line.strip()
                if line.startswith("Locator:") and "Bank" not in line:
                    current["slot"] = line.split(":", 1)[1].strip()
                elif line.startswith("Size:") and "No Module" not in line:
                    size_str = line.split(":", 1)[1].strip()
                    try:
                        if "GB" in size_str:
                            current["size_gb"] = int(float(size_str.replace("GB", "").strip()))
                        elif "MB" in size_str:
                            current["size_gb"] = max(1, round(float(size_str.replace("MB", "").strip()) / 1024))
                    except ValueError:
                        pass
                elif line.startswith("Speed:") and "Unknown" not in line:
                    speed_str = line.split(":", 1)[1].strip()
                    try:
                        current["freq_mhz"] = int(speed_str.replace("MHz", "").replace("MT/s", "").strip())
                    except ValueError:
                        pass
                elif line.startswith("Type:") and "Unknown" not in line:
                    t = line.split(":", 1)[1].strip()
                    if "DDR5" in t:
                        mem_type = "DDR5"
                    elif "DDR4" in t:
                        mem_type = "DDR4"
                    elif "DDR3" in t:
                        mem_type = "DDR3"
                elif line == "" and current.get("slot") and current.get("size_gb"):
                    sticks.append(current)
                    current = {}
            if current.get("slot") and current.get("size_gb"):
                sticks.append(current)
        except Exception:
            pass

    # Fallback if nothing detected
    if not sticks:
        est_count = max(1, min(4, round(total_gb / 8)))
        est_size = max(2, round(total_gb / est_count))
        sticks = [{"slot": f"DIMM_{i+1}", "size_gb": est_size, "freq_mhz": 2666}
                  for i in range(est_count)]

    return {
        "channels": min(len(sticks), 4),
        "type": mem_type,
        "sticks": sticks[:8],
    }


def _detect_gpu(system):
    """Detect GPUs via NVML (NVIDIA) or PowerShell fallback."""
    gpus = []

    # Try NVML first (most accurate for NVIDIA)
    try:
        import pynvml
        pynvml.nvmlInit()
        count = pynvml.nvmlDeviceGetCount()
        for i in range(count):
            handle = pynvml.nvmlDeviceGetHandleByIndex(i)
            name = pynvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode("utf-8")
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            gpus.append({
                "id": f"gpu{i}",
                "slot": f"PCIe_x16_{i}",
                "model": name,
                "vram_gb": round(mem.total / (1024**3)),
            })
        pynvml.nvmlShutdown()
        if gpus:
            return gpus
    except Exception:
        pass

    # Fallback: PowerShell on Windows
    if system == "Windows":
        data = _run_powershell(
            "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json"
        )
        if data:
            if not isinstance(data, list):
                data = [data]
            for idx, item in enumerate(data):
                name = item.get("Name", f"GPU {idx}")
                vram_bytes = item.get("AdapterRAM", 0) or 0
                vram_gb = max(1, round(vram_bytes / (1024**3)))
                gpus.append({
                    "id": f"gpu{idx}",
                    "slot": f"PCIe_x16_{idx}",
                    "model": name,
                    "vram_gb": vram_gb,
                })

    return gpus


def _detect_storage(system):
    """Detect storage devices (NVMe SSDs, SATA drives)."""
    storage = []

    if system == "Windows":
        data = _run_powershell(
            "Get-CimInstance Win32_DiskDrive | Select-Object Model,InterfaceType,Size,MediaType | ConvertTo-Json"
        )
        if data:
            if not isinstance(data, list):
                data = [data]
            for i, item in enumerate(data):
                model = item.get("Model", f"Disk {i}")
                size_bytes = item.get("Size", 0) or 0
                capacity_tb = round(size_bytes / (1024**4), 2)
                iface = item.get("InterfaceType", "")
                media = item.get("MediaType", "") or ""

                is_nvme = "nvme" in model.lower() or "nvme" in iface.lower() or "ssd" in media.lower()
                interface = "M2_PCIe4x4" if is_nvme else "SATA"

                if capacity_tb > 0:
                    storage.append({
                        "id": f"disk{i}",
                        "interface": interface,
                        "model": f"{model.strip()}",
                        "capacity_tb": capacity_tb,
                        "via": "cpu" if is_nvme else "pch",
                    })
    else:
        # Linux: use lsblk
        try:
            result = subprocess.run(
                ["lsblk", "-d", "-o", "NAME,SIZE,MODEL,ROTA", "--json"],
                capture_output=True, text=True, timeout=5,
            )
            data = json.loads(result.stdout)
            for i, item in enumerate(data.get("blockdevices", [])):
                name = item.get("name", "")
                if name.startswith("loop") or name.startswith("ram"):
                    continue
                model = item.get("model", name) or name
                size_str = item.get("size", "0")
                # Parse size (e.g., "500G", "1T")
                try:
                    if "T" in str(size_str).upper():
                        capacity_tb = float(str(size_str).upper().replace("T", ""))
                    elif "G" in str(size_str).upper():
                        capacity_tb = round(float(str(size_str).upper().replace("G", "")) / 1024, 2)
                    else:
                        capacity_tb = 0.5
                except ValueError:
                    capacity_tb = 0.5

                is_nvme = "nvme" in name
                storage.append({
                    "id": f"disk{i}",
                    "interface": "M2_PCIe4x4" if is_nvme else "SATA",
                    "model": model.strip(),
                    "capacity_tb": capacity_tb,
                    "via": "cpu" if is_nvme else "pch",
                })
        except Exception:
            pass

    return storage[:4]


def _detect_network(system):
    """Detect primary physical network interface."""
    nics = []

    if system == "Windows":
        data = _run_powershell(
            "Get-CimInstance Win32_NetworkAdapter | Where-Object {$_.PhysicalAdapter -eq $true -and $_.NetEnabled -eq $true} | Select-Object Name,Speed,MACAddress | ConvertTo-Json"
        )
        if data:
            if not isinstance(data, list):
                data = [data]
            for i, item in enumerate(data):
                name = item.get("Name", f"NIC {i}")
                speed_bps = item.get("Speed", 0) or 0
                speed_mbps = round(speed_bps / 1_000_000) if speed_bps else 0

                # Skip virtual adapters
                skip_words = ["virtual", "vmware", "vbox", "hyper-v", "zerotier", "tun", "tap", "loopback"]
                if any(w in name.lower() for w in skip_words):
                    continue

                iface = f"{speed_mbps}MbE" if speed_mbps > 0 else "Ethernet"
                nics.append({
                    "id": f"nic{len(nics)}",
                    "interface": iface,
                    "model": name,
                    "via": "pch",
                })
                if len(nics) >= 2:
                    break

    if not nics:
        # Fallback: use psutil
        try:
            stats = psutil.net_if_stats()
            for name, stat in stats.items():
                if not stat.isup or name.startswith("lo") or "Loopback" in name:
                    continue
                skip_words = ["virtual", "vmware", "vbox", "zerotier", "tun", "tap", "veth"]
                if any(w in name.lower() for w in skip_words):
                    continue
                speed = stat.speed or 0
                iface = f"{speed}MbE" if speed > 0 else "Ethernet"
                nics.append({"id": "nic0", "interface": iface, "model": name, "via": "pch"})
                break
        except Exception:
            pass

    if not nics:
        nics.append({"id": "nic0", "interface": "Ethernet", "model": "Network Adapter", "via": "pch"})

    return nics
