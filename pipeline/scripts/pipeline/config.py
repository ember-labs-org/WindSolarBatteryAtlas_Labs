
import os
from pathlib import Path

# ATLAS_WORKSPACE_DIR and ATLAS_DOCS_DATA_DIR let a run read one workspace and
# write the deployable files somewhere else (T054 ran from a scratch harness so
# nothing was written inside the OneDrive-synced workspace).
WORKSPACE_DIR = Path(os.environ.get("ATLAS_WORKSPACE_DIR") or Path(__file__).resolve().parents[2])
REPO_ROOT = WORKSPACE_DIR.parent
DEPLOYMENT_DIR = REPO_ROOT / "deployment"

# Paths
INPUTS_DIR = WORKSPACE_DIR / "input_data"
OUTPUTS_DIR = WORKSPACE_DIR / "outputs"

# Legacy alias (deprecated, prefer specific dir)
DATA_DIR = INPUTS_DIR

CACHE_DIR = INPUTS_DIR / "cache"
DOCS_DATA_DIR = Path(os.environ.get("ATLAS_DOCS_DATA_DIR") or DEPLOYMENT_DIR / "data")

SOLAR_PROFILES_PATH = INPUTS_DIR / "solar_profiles.csv"
SOLAR_PROFILES_PARQUET = INPUTS_DIR / "solar_profiles.parquet"
WIND_PROFILES_ON_PARQUET = INPUTS_DIR / "wind_profiles_on.parquet"
WIND_PROFILES_OFF_PARQUET = INPUTS_DIR / "wind_profiles_off.parquet"
WIND_RESOURCE_CSV = OUTPUTS_DIR / "voronoi_wind_resource.csv"

# Simulation Parameters
BASELOAD_GW = 1.0
BATTERY_ROUND_TRIP_EFFICIENCY = 0.90

# Solar Capacity: 1 to 20 GW in 1 GW increments
SOLAR_CAPACITIES_GW = list(range(1, 21))

# Battery Capacity: 0 to 36 GWh in 2 GWh increments
BATTERY_CAPACITIES_GWH = list(range(0, 38, 2))

# Season Definitions (Month indices, 1-based)
SEASONS = {
    "winter": 1,  # January
    "spring": 4,  # April
    "summer": 7,  # July
    "fall": 10,   # October
}

# Sample Duration (hours)
SAMPLE_DURATION_HOURS = 72


# ---------------------------------------------------------------------------
# Wind dimension
# ---------------------------------------------------------------------------
# Wind capacity levels (GW). Level 0 reproduces the original solar + battery
# atlas exactly, so the published results remain reachable inside this tool.
WIND_CAPACITIES_GW = [0, 1, 2, 3, 4, 5, 6, 8]

# With wind in the mix the interesting solar range is smaller, and solar 0 must
# be reachable (wind-only systems), so the grid differs by wind level.
WIND_ON_SOLAR_CAPACITIES_GW = list(range(0, 11))

N_HOURS = 8784          # 2024 is a leap year
SURFACES = ("on", "off")


def build_config_list():
    """Every simulated (surface, solar, wind, battery) triple, with a stable index.

    Rules:
      wind == 0 : exactly the original 290 configurations (solar 1-20, battery
                  0-36 step 2, skipping solar > 10 with battery <= 16). Only on
                  the onshore surface, since with no wind the surface is moot.
      wind  > 0 : solar 0-10, battery 0-36 step 2, on both surfaces.
    """
    configs = []
    for solar in SOLAR_CAPACITIES_GW:
        for batt in BATTERY_CAPACITIES_GWH:
            if solar > 10 and batt <= 16:
                continue
            configs.append(("on", solar, 0, batt))
    for surface in SURFACES:
        for wind in WIND_CAPACITIES_GW:
            if wind == 0:
                continue
            for solar in WIND_ON_SOLAR_CAPACITIES_GW:
                for batt in BATTERY_CAPACITIES_GWH:
                    configs.append((surface, solar, wind, batt))
    return [(i, *c) for i, c in enumerate(configs)]


def shard_name(surface: str, solar: int, wind: int, batt: int) -> str:
    tag = "" if wind == 0 else ("w" if surface == "on" else "wo")
    if wind == 0:
        return f"samples_s{solar}_b{batt}.parquet"
    return f"samples_s{solar}_{tag}{wind}_b{batt}.parquet"


def summary_name(surface: str, wind: int) -> str:
    if wind == 0:
        return "summary_w0.parquet"
    return f"summary_{'w' if surface == 'on' else 'wo'}{wind}.parquet"
