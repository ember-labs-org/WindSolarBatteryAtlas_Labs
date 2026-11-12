"""T066 Phase A: pick the pilot regions and fetch NASA POWER (2015-2024 LST, 2020 UTC GHI)
and PVGIS 5.3 seriescalc 2020 for each. Raw files kept under <ROOT>/raw/."""
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
import pandas as pd
import requests

import power_pv as PP
from pvmodel import opt_tilt

T064 = Path.home() / "wind-atlas-T064"
SITES = {  # name: (lat, lon) of a representative solar area; the nearest region centroid is used
    "Germany (Brandenburg)": (52.4, 13.4), "UK (S England)": (51.3, -1.0),
    "Norway (Oslo)": (59.9, 10.8), "Spain (Castilla-La Mancha)": (39.5, -3.5),
    "Morocco (Ouarzazate)": (30.9, -6.9), "India (Rajasthan)": (26.9, 72.6),
    "Brazil (Bahia)": (-13.3, -43.4), "Kenya (Nairobi)": (-1.3, 36.8),
    "Australia (NSW)": (-33.0, 147.0), "Chile (Atacama)": (-23.0, -69.5),
    "Texas (W Texas)": (31.9, -102.1), "Japan (Kanto)": (36.0, 139.8),
}


def pick():
    pts = pd.read_csv(T064 / "work/solar_points.csv")
    rows = []
    for name, (la, lo) in SITES.items():
        p1, p2 = np.radians(la), np.radians(pts.latitude.values)
        dl = np.radians(pts.longitude.values - lo)
        d = 6371 * np.arccos(np.clip(np.sin(p1) * np.sin(p2) + np.cos(p1) * np.cos(p2) * np.cos(dl), -1, 1))
        i = int(np.argmin(d))
        rows.append(dict(site=name, location_id=int(pts.location_id[i]), lat=float(pts.latitude[i]),
                         lon=float(pts.longitude[i]), km_from_target=round(float(d[i]), 0)))
    return pd.DataFrame(rows)


def pvgis(row, tilt):
    p = PP.ROOT / "raw" / "pvgis" / f"{row.location_id}_2020.json"
    if p.exists():
        return
    lat, lon = row.lat, row.lon
    q = dict(lat=f"{lat:.4f}", lon=f"{lon:.4f}", startyear=2020, endyear=2020, pvcalculation=1,
             peakpower=1, loss=14, angle=f"{tilt:.1f}", aspect=0 if lat >= 0 else 180,
             components=1, outputformat="json", usehorizon=0)
    wait = 5
    for _ in range(8):
        r = requests.get("https://re.jrc.ec.europa.eu/api/v5_3/seriescalc", params=q, timeout=120)
        if r.status_code == 200:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(r.content)
            return
        print("pvgis", row.location_id, r.status_code, r.text[:200], flush=True)
        if r.status_code in (400, 404):
            return
        time.sleep(wait); wait *= 2


if __name__ == "__main__":
    s = pick()
    s["tilt"] = [opt_tilt(v) for v in s.lat]
    s.to_csv(PP.ROOT / "pilot_sites.csv", index=False)
    print(s.to_string())

    def job(r):
        PP.fetch_all(r.location_id, r.lat, r.lon)
        PP.fetch(r.location_id, r.lat, r.lon, 2020, 2020, ts="UTC", params=["ALLSKY_SFC_SW_DWN"])
        pvgis(r, r.tilt)
        return r.location_id
    with ThreadPoolExecutor(3) as ex:
        for loc in ex.map(job, s.itertuples()):
            print("done", loc, flush=True)
