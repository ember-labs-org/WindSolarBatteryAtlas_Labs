"""Bulk NASA POWER fetch 2015-2023 (LST) for every region; resumable, 3 concurrent."""
import sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pandas as pd
import power as P
pts = pd.read_csv(P.ROOT / "work/solar_points.csv")
for pass_ in range(1, 7):
  todo = [r for r in pts.itertuples() if not P.cache_path("2015_2023", r.location_id).exists()]
  print(f"pass {pass_}: {len(pts)} regions, {len(todo)} to fetch", flush=True)
  if not todo:
    break
  t0 = time.time(); done = 0; fail = []
  def job(r):
    P.fetch(int(r.location_id), float(r.latitude), float(r.longitude), 2015, 2023)
    return r.location_id
  with ThreadPoolExecutor(3) as ex:
    futs = {ex.submit(job, r): r.location_id for r in todo}
    for f in as_completed(futs):
        try:
            f.result()
        except Exception as e:
            fail.append(futs[f]); print(f"FAIL {futs[f]}: {e}", flush=True)
        done += 1
        if done % 100 == 0:
            el = time.time() - t0
            print(f"{done}/{len(todo)} {el/60:.1f} min, {(len(todo)-done)*el/done/60:.1f} min left", flush=True)
  print(f"pass {pass_} done {done}, failed {len(fail)}: {fail[:20]} in {(time.time()-t0)/60:.1f} min", flush=True)
  if fail:
    time.sleep(600)
left = sum(not P.cache_path("2015_2023", r.location_id).exists() for r in pts.itertuples())
print(f"regions still missing: {left}", flush=True)
sys.exit(1 if left else 0)
