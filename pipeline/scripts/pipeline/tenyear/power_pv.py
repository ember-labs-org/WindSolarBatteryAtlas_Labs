"""NASA POWER hourly fetch of the PV-model inputs (T066).

Two requests per region (2015-2019 and 2020-2024: the API refuses a ten-year JSON
request for six parameters, "please shorten your requested time extent"), community RE, time-standard LST (same clock
as the T060 GHI files): ALLSKY_SFC_SW_DWN (GHI), ALLSKY_SFC_SW_DNI, ALLSKY_SFC_SW_DIFF,
T2M, WS10M, ALLSKY_SRF_ALB. GHI is fetched again in the same request (no extra call)
because the T060 2015-2023 GHI caches are no longer on disk.

Raw responses are kept gzipped under <ROOT>/raw/power_pv/<span>/<location_id>.json.gz;
a file is written only after it parses with the expected hours for every parameter.
Retry with exponential backoff on HTTP 429/5xx and network errors.
"""
from __future__ import annotations

import gzip
import json
import os
import time
from pathlib import Path

import numpy as np
import requests

API = "https://power.larc.nasa.gov/api/temporal/hourly/point"
ROOT = Path(os.environ.get("T066_ROOT", str(Path.home() / "wind-atlas-T066")))
PARAMS = ["ALLSKY_SFC_SW_DWN", "ALLSKY_SFC_SW_DNI", "ALLSKY_SFC_SW_DIFF", "T2M", "WS10M",
          "ALLSKY_SRF_ALB"]
Y0, Y1 = 2015, 2024
SPANS = [(2015, 2019), (2020, 2024)]
_s = requests.Session()


def hours_in(y0: int, y1: int) -> int:
    return int((np.datetime64(f"{y1 + 1}-01-01") - np.datetime64(f"{y0}-01-01")).astype(int) * 24)


def cache_path(loc: int, span: str = f"{Y0}_{Y1}", ts: str = "LST") -> Path:
    sub = span if ts == "LST" else f"{span}_{ts}"
    return ROOT / "raw" / "power_pv" / sub / f"{loc}.json.gz"


def fetch(loc: int, lat: float, lon: float, y0: int = Y0, y1: int = Y1, ts: str = "LST",
          params: list[str] | None = None, retries: int = 40) -> dict:
    params = params or PARAMS
    p = cache_path(loc, f"{y0}_{y1}", ts)
    if p.exists():
        return json.loads(gzip.decompress(p.read_bytes()))
    q = dict(parameters=",".join(params), community="RE", longitude=f"{lon:.4f}",
             latitude=f"{lat:.4f}", start=f"{y0}0101", end=f"{y1}1231", format="JSON",
             **{"time-standard": ts})
    wait = 5.0
    for attempt in range(retries):
        try:
            r = _s.get(API, params=q, timeout=300)
            if r.status_code == 429 or r.status_code >= 500:
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            d = r.json()
            assert d["header"]["time_standard"] == ts
            for k in params:
                n = len(d["properties"]["parameter"][k])
                if n != hours_in(y0, y1):
                    raise ValueError(f"loc {loc} {k}: {n} hours, expected {hours_in(y0, y1)}")
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".tmp")
            tmp.write_bytes(gzip.compress(r.content, 6))
            tmp.rename(p)
            return d
        except (requests.RequestException, ValueError, KeyError) as e:
            if attempt == retries - 1:
                raise
            print(f"  retry loc {loc} in {wait:.0f} s: {type(e).__name__}: {str(e)[:120]}", flush=True)
            time.sleep(wait)
            wait = min(wait * 2, 300)
    raise RuntimeError("unreachable")


def fetch_all(loc: int, lat: float, lon: float) -> list[dict]:
    return [fetch(loc, lat, lon, a, b) for a, b in SPANS]


def load(loc: int) -> dict[str, np.ndarray]:
    """2015-2024 arrays for a region from its two cached spans."""
    parts = [arrays(json.loads(gzip.decompress(cache_path(loc, f"{a}_{b}").read_bytes())), a, b)
             for a, b in SPANS]
    return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


def arrays(d: dict, y0: int = Y0, y1: int = Y1) -> dict[str, np.ndarray]:
    """Parameter arrays in strict hourly order (raises on a gap, duplicate or reorder)."""
    out = {}
    exp = np.arange(np.datetime64(f"{y0}-01-01T00"), np.datetime64(f"{y1 + 1}-01-01T00"),
                    np.timedelta64(1, "h"))
    for k, vals in d["properties"]["parameter"].items():
        keys = list(vals.keys())
        got = np.array([np.datetime64(f"{s[:4]}-{s[4:6]}-{s[6:8]}T{s[8:10]}") for s in keys])
        if len(got) != len(exp) or not np.array_equal(got, exp):
            raise ValueError(f"{k}: missing, duplicate or out-of-order hours")
        out[k] = np.fromiter(vals.values(), dtype="float64", count=len(keys))
    out["time"] = exp
    return out
