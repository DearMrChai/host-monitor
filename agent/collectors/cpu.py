"""CPU metric collector - cross-platform via psutil."""
import time

import psutil
import platform
import subprocess

# wmic is removed on Win11 24H2+; thermal zone needs a CIM call which is
# expensive (powershell spin-up), so refresh at most every 60s and serve the cache.
_thermal_cache = {"value": None, "ts": 0.0}


def _windows_thermal():
    now = time.time()
    if now - _thermal_cache["ts"] < 60:
        return _thermal_cache["value"]
    _thermal_cache["ts"] = now
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature "
             "| Select-Object -First 1 -ExpandProperty CurrentTemperature)"],
            capture_output=True, text=True, timeout=10,
        )
        _thermal_cache["value"] = round(float(out.stdout.strip()) / 10.0 - 273.15, 1)
    except Exception:
        _thermal_cache["value"] = None
    return _thermal_cache["value"]


def collect():
    """Collect CPU metrics: usage (total + per-core), cores, frequency, temperature."""
    per_core = psutil.cpu_percent(interval=0.5, percpu=True)
    data = {
        "usage_percent": round(sum(per_core) / len(per_core), 1) if per_core else 0.0,
        "per_core": per_core,
        "cores": psutil.cpu_count(logical=True),
        "cores_physical": psutil.cpu_count(logical=False),
        "freq_mhz": None,
        "temperature_c": None,
    }

    # CPU frequency
    try:
        freq = psutil.cpu_freq()
        if freq:
            data["freq_mhz"] = round(freq.current, 0)
    except Exception:
        pass

    # CPU temperature (Linux: psutil sensors; Windows: WMI)
    try:
        temps = psutil.sensors_temperatures()
        if temps:
            for key in ("coretemp", "cpu_thermal", "k10temp", "zenpower"):
                if key in temps and temps[key]:
                    data["temperature_c"] = round(temps[key][0].current, 1)
                    break
    except (AttributeError, Exception):
        pass

    # Windows fallback: WMI thermal zone (CIM; often needs admin -> stays None)
    if data["temperature_c"] is None and platform.system() == "Windows":
        data["temperature_c"] = _windows_thermal()

    return data
