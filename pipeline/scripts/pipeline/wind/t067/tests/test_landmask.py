"""T067 fix 1 tests on the built rasters (~/wind-atlas-T067/ws_T067) against T061's.

  python3 -I test_landmask.py [run dir]
"""
import sys
from pathlib import Path

import numpy as np
import rasterio

R = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "wind-atlas-T067"
T61 = Path.home() / "wind-atlas-T061"
new = R / "ws_T067/input_data/wind"
fails = 0


def ok(c, m):
    global fails
    print(("PASS " if c else "FAIL ") + m)
    fails += not c


def rd(p):
    with rasterio.open(p) as s:
        return s.read(1)


def px(lon, lat):
    return int((90 - lat) / 0.02), int((lon + 180) / 0.02)


def box(a, lon0, lon1, lat0, lat1):
    return a[int((90 - lat1) / 0.02):int((90 - lat0) / 0.02), int((lon0 + 180) / 0.02):int((lon1 + 180) / 0.02)]


on_o, on_n = rd(T61 / "ws_D/input_data/wind/eligible_onshore_002deg.tif"), rd(new / "eligible_onshore_002deg.tif")
off_o, off_n = rd(T61 / "ws_D/input_data/wind/eligible_offshore_002deg.tif"), rd(new / "eligible_offshore_002deg.tif")
land_o, land_n = rd(R / "inputs/ws_wind/land_002deg.tif"), rd(new / "land_002deg.tif")
z = np.load(R / "cache/landmask_diff.npz")
flip, lake, casp = z["flip"], z["lake"], z["casp"]

# polders and depressions are land and onshore-eligible now, not offshore
for name, (lon0, lon1, lat0, lat1) in {"Flevoland": (5.25, 5.85, 52.3, 52.55), "Noordoostpolder": (5.6, 5.9, 52.6, 52.8),
                                        "Wieringermeer": (4.95, 5.15, 52.8, 52.9), "Atyrau lowland": (51.5, 52.5, 46.8, 47.4),
                                        "Qattara": (26.5, 28.5, 29.3, 29.9), "Imperial Valley": (-115.8, -115.4, 32.8, 33.1)}.items():
    lo, ln = box(land_o, lon0, lon1, lat0, lat1).mean(), box(land_n, lon0, lon1, lat0, lat1).mean()
    eo, en = (box(on_o, lon0, lon1, lat0, lat1) > 0).mean(), (box(on_n, lon0, lon1, lat0, lat1) > 0).mean()
    fo, fn = (box(off_o, lon0, lon1, lat0, lat1) > 0).mean(), (box(off_n, lon0, lon1, lat0, lat1) > 0).mean()
    # the Atyrau box takes in a strip of the Ural delta's open water (ESMAP water, stays sea)
    ok(ln > 0.5 and en > eo and fn <= 0.02, f"{name}: land {lo:.0%}->{ln:.0%}, onshore-eligible {eo:.0%}->{en:.0%}, offshore {fo:.0%}->{fn:.0%}")
# no offshore on any Natural Earth lake, and none on land
ok(int(((off_n > 0) & lake).sum()) == 0, f"no offshore pixel on a lake (was {int(((off_o > 0) & lake).sum())})")
ok(int(((off_n > 0) & (land_n == 1)).sum()) == 0, "no offshore pixel on land")
# outside the changed classes nothing moves
changed_on = on_o != on_n
ok(not changed_on[~flip].any(), "onshore changes only on flipped pixels")
gain = (off_n > 0) & (off_o == 0)
ok(not gain[~casp].any(), f"offshore gains only in the Caspian ({int(gain.sum())} px)")
# Caspian depth from its -28 m surface: North Caspian (~2-5 m water) eligible, depth raster re-referenced
d = rd(new / "depth_002deg.tif")
r, c = px(50.0, 46.0)
ok(d[r, c] <= 5, f"North Caspian water depth {d[r, c]} m (sea-level depth 30 m); this pixel is a marine PA (pa_all 100)")
ok(int(gain.sum()) > 0 and int(gain.sum()) == int((gain & casp).sum()),
   "Caspian sea-level depths 60-88 m (water 32-60 m) become fixed-bottom eligible")
# Wieringermeer-type dry polders no longer 'offshore'
ok(int(((off_o > 0) & flip).sum()) > 0 and int(((off_n > 0) & flip).sum()) == 0,
   f"offshore on flipped land {int(((off_o > 0) & flip).sum())} px -> 0")
print("ALL PASS" if not fails else f"FAIL {fails}")
sys.exit(1 if fails else 0)
