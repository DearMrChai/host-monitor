"""CPU metric collector - cross-platform via psutil."""
import psutil
import platform
import subprocess


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

    # Windows fallback: WMI thermal zone
    if data["temperature_c"] is None and platform.system() == "Windows":
        try:
            result = subprocess.run(
                ["wmic", "/namespace:\\\\root\\\\wmi", "PATH",
                 "MSAcpi_ThermalZoneTemperature", "get", "CurrentTemperature"],
                capture_output=True, text=True, timeout=5,
            )
            lines = [l.strip() for l in result.stdout.strip().split("\n") if l.strip()]
            if len(lines) > 1:
                kelvin_tenths = int(lines[1])
                data["temperature_c"] = round(kelvin_tenths / 10.0 - 273.15, 1)
        except Exception:
            pass

    return data
