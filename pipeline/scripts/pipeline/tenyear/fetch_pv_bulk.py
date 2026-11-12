"""T066 bulk NASA POWER fetch of PV inputs (2015-2019, 2020-2024 LST) for every region.
Resumable, 3 concurrent requests, retry with backoff (power_pv.fetch); stops if free disk < 15 GB."""
import shutil, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pandas as pd
import power_pv as PP

pts = pd.read_csv(Path.home() / "wind-atlas-T064/work/solar_points.csv")
def done(r):
    return all(PP.cache_path(int(r.location_id), f"{a}_{b}").exists() for a, b in PP.SPANS)
def free_gb():
    return shutil.disk_usage(Path.home()).free / 1e9
for pass_ in range(1, 7):
    todo = [r for r in pts.itertuples() if not done(r)]
    print(f"pass {pass_}: {len(pts)} regions, {len(todo)} to fetch, free {free_gb():.1f} GB", flush=True)
    if not todo:
        break
    t0 = time.time(); n = 0; fail = []
    def job(r):
        if free_gb() < 15:
            raise SystemExit("free disk below 15 GB")
        PP.fetch_all(int(r.location_id), float(r.latitude), float(r.longitude))
    with ThreadPoolExecutor(3) as ex:
        futs = {ex.submit(job, r): r.location_id for r in todo}
        for f in as_completed(futs):
            try:
                f.result()
            except BaseException as e:
                fail.append(futs[f]); print(f"FAIL {futs[f]}: {e}", flush=True)
            n += 1
            if n % 100 == 0:
                el = time.time() - t0
                print(f"{n}/{len(todo)} {el/60:.1f} min, {(len(todo)-n)*el/n/60:.0f} min left, free {free_gb():.1f} GB", flush=True)
    print(f"pass {pass_} done {n}, failed {len(fail)}: {fail[:20]}", flush=True)
    if free_gb() < 15:
        print("STOP: free disk below 15 GB", flush=True); sys.exit(2)
    if fail:
        time.sleep(600)
left = sum(not done(r) for r in pts.itertuples())
print(f"regions still missing: {left}", flush=True)
sys.exit(1 if left else 0)
