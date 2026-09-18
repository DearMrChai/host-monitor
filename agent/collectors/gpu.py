"""GPU metric collector - NVIDIA via nvidia-ml-py, graceful fallback if unavailable."""
import warnings
import platform

warnings.filterwarnings("ignore", category=FutureWarning)

_nvml_available = False
_nvml = None

try:
    import pynvml as _nvml
    _nvml.nvmlInit()
    _nvml_available = True
except Exception:
    pass


def collect():
    """Collect GPU metrics for all detected GPUs.

    Returns a list of dicts, one per GPU.
    Falls back to empty list if no NVIDIA GPU / pynvml unavailable.
    """
    if not _nvml_available:
        return _collect_fallback()

    gpus = []
    try:
        count = _nvml.nvmlDeviceGetCount()
        for i in range(count):
            handle = _nvml.nvmlDeviceGetHandleByIndex(i)
            name = _nvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode("utf-8")

            # Utilization
            try:
                util = _nvml.nvmlDeviceGetUtilizationRates(handle)
                gpu_percent = util.gpu
                mem_percent = util.memory
            except Exception:
                gpu_percent = None
                mem_percent = None

            # VRAM
            try:
                mem_info = _nvml.nvmlDeviceGetMemoryInfo(handle)
                vram_used_mb = mem_info.used // (1024 * 1024)
                vram_total_mb = mem_info.total // (1024 * 1024)
            except Exception:
                vram_used_mb = None
                vram_total_mb = None

            # Temperature
            try:
                temp = _nvml.nvmlDeviceGetTemperature(handle, _nvml.NVML_TEMPERATURE_GPU)
            except Exception:
                temp = None

            gpus.append({
                "index": i,
                "name": name,
                "usage_percent": gpu_percent,
                "mem_percent": mem_percent,
                "vram_used_mb": vram_used_mb,
                "vram_total_mb": vram_total_mb,
                "temperature_c": temp,
            })
    except Exception:
        pass

    return gpus


def _collect_fallback():
    """Fallback: try to detect GPUs via system commands (basic info only)."""
    gpus = []
    system = platform.system()

    if system == "Windows":
        try:
            import subprocess
            result = subprocess.run(
                ["wmic", "path", "win32_VideoController", "get", "name,AdapterRAM"],
                capture_output=True, text=True, timeout=5,
            )
            lines = [l.strip() for l in result.stdout.strip().split("\n") if l.strip()]
            for idx, line in enumerate(lines[1:]):  # skip header
                parts = line.rsplit(None, 1)
                if len(parts) >= 1:
                    name = parts[0] if len(parts) == 2 else line
                    gpus.append({
                        "index": idx,
                        "name": name.strip(),
                        "usage_percent": None,
                        "vram_used_mb": None,
                        "vram_total_mb": None,
                        "temperature_c": None,
                    })
        except Exception:
            pass

    return gpus


def shutdown():
    """Cleanup NVML resources."""
    global _nvml_available
    if _nvml_available:
        try:
            _nvml.nvmlShutdown()
        except Exception:
            pass
        _nvml_available = False
