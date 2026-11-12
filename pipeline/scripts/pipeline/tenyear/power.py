"""NASA POWER hourly point fetcher (T060).

One request per region for a year range, ALLSKY_SFC_SW_DWN only, community RE,
time-standard LST (local solar time: the clock of the shipped 2024 profile).
Raw responses are cached gzipped under raw/power/<span>/<location_id>.json.gz so a
run can be stopped and resumed; a cached file is only written after it parses
and has the expected number of hours.

kwh_per_kw = round(ALLSKY_SFC_SW_DWN [Wh/m2] x 0.0008, 4): reverse-engineered
from the shipped 2024 profile (gate A2).
"""
from __future__ import annotations

import os
import gzip
import json
import time
from datetime import date
from pathlib import Path

import numpy as np
import requests

API = "https://power.larc.nasa.gov/api/temporal/hourly/point"
ROOT = Path(os.environ.get("TENYEAR_ROOT", str(Path.home() / "wind-atlas-T064")))  # T064 run dir (T060: ~/wind-atlas-T060)
PR = 0.0008

_s = requests.Session()


def hours_in(y0: int, y1: int) -> int:
    return sum((date(y + 1, 1, 1) - date(y, 1, 1)).days * 24 for y in range(y0, y1 + 1))


def cache_path(span: str, loc: int) -> Path:
    return ROOT / "raw" / "power" / span / f"{loc}.json.gz"


def fetch(loc: int, lat: float, lon: float, y0: int, y1: int, span: str | None = None,
          retries: int = 60) -> dict:
    span = span or f"{y0}_{y1}"
    p = cache_path(span, loc)
    if p.exists():
        return json.loads(gzip.decompress(p.read_bytes()))
    params = dict(parameters="ALLSKY_SFC_SW_DWN", community="RE", longitude=f"{lon:.4f}",
                  latitude=f"{lat:.4f}", start=f"{y0}0101", end=f"{y1}1231", format="JSON",
                  **{"time-standard": "LST"})
    wait = 5.0
    for attempt in range(retries):
        try:
            r = _s.get(API, params=params, timeout=180)
            if r.status_code == 429 or r.status_code >= 500:
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            d = r.json()
            vals = d["properties"]["parameter"]["ALLSKY_SFC_SW_DWN"]
            if len(vals) != hours_in(y0, y1):
                raise ValueError(f"loc {loc}: {len(vals)} hours, expected {hours_in(y0, y1)}")
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".tmp")
            tmp.write_bytes(gzip.compress(r.content, 6))
            tmp.rename(p)
            return d
        except (requests.RequestException, ValueError, KeyError) as e:
            if attempt == retries - 1:
                raise
            time.sleep(wait)
            print(f"  retry loc {loc} in {wait:.0f} s: {type(e).__name__}: {str(e)[:120]}", flush=True)
            wait = min(wait * 2, 300)
    raise RuntimeError("unreachable")


def series(d: dict, y0: int, y1: int) -> tuple[np.ndarray, np.ndarray]:
    """(irradiance float64 in time order, keys) with a strict hour-by-hour check."""
    vals = d["properties"]["parameter"]["ALLSKY_SFC_SW_DWN"]
    keys = list(vals.keys())
    exp = np.arange(np.datetime64(f"{y0}-01-01T00"), np.datetime64(f"{y1 + 1}-01-01T00"),
                    np.timedelta64(1, "h"))
    got = np.array([np.datetime64(f"{k[:4]}-{k[4:6]}-{k[6:8]}T{k[8:10]}") for k in keys])
    if len(got) != len(exp) or not np.array_equal(got, exp):
        raise ValueError("missing, duplicate or out-of-order hours")
    g = np.array([vals[k] for k in keys], dtype="float64")
    return g, got


def to_kwh(g: np.ndarray) -> np.ndarray:
    return np.round(g * PR, 4)
