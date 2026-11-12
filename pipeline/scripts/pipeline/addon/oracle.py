"""T058: the add-on oracle. Full expected cost-view results for every cost key, with
the add-on off (base) and on, computed independently of the app's JS from:
  * the data files (configs.json, the summary slices, addon.json + its parquets),
  * the params and lookups the page sent the worker for each key
    (drive_keys.mjs -> params_dump.json; T058-interface.md §5),
  * the cost model common.precompute / common.lcoe_full (check_cost.py: equal to
    the worker in every pricing mode), here vectorised with the same operation order.
Search rules: team/contracts/T058.md "Search" and T058-interface.md §4.

Output (T058-interface.md §6): <out> (gzip JSON), and a self-check: for every key
the base digest must equal the digest the app drew with the add-on off
(drive_keys.mjs -> digests_addon0.json). Exit 1 if it does not.

  T058_OUT=<scratch> python3 -I oracle.py --data <repo>/deployment/data \
      --dump <dir>/params_dump.json --drawn <dir>/digests_addon0.json --out <repo>/checks/addon_oracle.json.gz
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import subprocess
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
import pandas as pd

import common as C

BASE = 1000.0
GUARD = 0.00005


# ---------------------------------------------------------------- formatting
def fix(v, d):
    """JS Number.prototype.toFixed (round half away from zero on the exact binary value)."""
    if v is None or not np.isfinite(v):
        return "-"
    q = Decimal(float(v)).quantize(Decimal(1).scaleb(-d), rounding=ROUND_HALF_UP)
    return format(q, "f")


def jsnum(v):
    """String(n) for the integers and fractional batteries a row holds."""
    v = float(v)
    if v.is_integer():
        return str(int(v))
    r = repr(v)
    return r


def flag(v):
    return 1 if v is True else 0 if v is False else "-"


def build(r):
    surf = f"both:{jsnum(r['wind_on_gw'])}+{jsnum(r['wind_off_gw'])}" if r["wind_surface"] == "both" else \
        (r["wind_surface"] if r["wind_gw"] else "on")
    batt = fix(r["batt_gwh"], 2) if r["interpolated"] else jsnum(r["batt_gwh"])
    return [str(r["location_id"]), jsnum(r["solar_gw"]), jsnum(r["wind_gw"]), surf, batt]


def digest(r, view):
    if view == "lcoe":
        parts = build(r) + [fix(r["lcoe"], 2), "1" if r["meetsTarget"] else "0", fix(r["annual_cf"], 4),
                            fix(r["windSaving"], 2), fix(r["maxConfigLcoe"], 2), fix(r["noWindLcoe"], 2)]
    else:
        parts = build(r) + [fix(r["cf"], 4), fix(r["lcoe"], 2), str(flag(r["meetsTarget"])), str(flag(r["targetLcoeMet"]))]
    return "|".join(str(p) for p in parts) + ("|i" if r["interpolated"] else "")


# ---------------------------------------------------------------- cost, vectorised
def lcoe_vec(pre, cf, solar, batt, on, off):
    """Worker fillLocationLcoe / computeLcoeMetrics, elementwise, same operation order;
    two wind surfaces as the add-on 'both' branch. NaN marks a skipped build
    (CF not > 0, or non-finite). cf may be float64 (interpolated rows: the target)."""
    cf = np.asarray(cf, dtype=np.float64)
    solar_kw = solar * 1_000_000.0; batt_kwh = batt * 1_000_000.0
    on_kw = on * 1_000_000.0; off_kw = off * 1_000_000.0
    solar_capex = pre["solar_per_kw"] * solar_kw
    batt_capex = pre["batt_base"] * batt_kwh
    on_capex = pre["on_base"] * on_kw
    off_capex = pre["off_base"] * off_kw
    both = (on_kw > 0) & (off_kw > 0)
    # one surface: exactly the worker's single wind term (the other is not added)
    wind_ann = np.where(both, on_capex * pre["on_crf"] + off_capex * pre["off_crf"],
                        np.where(off_kw > 0, off_capex * pre["off_crf"], on_capex * pre["on_crf"]))
    wind_opex = np.where(both, on_capex * pre["on_opex"] + off_capex * pre["off_opex"],
                         np.where(off_kw > 0, off_capex * pre["off_opex"], on_capex * pre["on_opex"]))
    cost = solar_capex * pre["solar_crf"] + batt_capex * pre["batt_crf"] + wind_ann \
        + solar_capex * pre["solar_opex"] + batt_capex * pre["batt_opex"] + wind_opex
    with np.errstate(invalid="ignore", divide="ignore"):
        # the renewables' energy after degradation (the no-backup denominator)
        energy = cf * 8760 * BASE
        s = solar_kw * pre["ucf_s"]
        a = np.where(off_kw > 0, 0.0, on_kw * pre["ucf_on"])
        a = np.where(both, on_kw * pre["ucf_on"], a)
        o = off_kw * pre["ucf_off"]
        # single surface: worker blendedDegradation(solarKw, windKw, solarCf, windCf, ...)
        w1 = np.where(off_kw > 0, o, on_kw * pre["ucf_on"])
        wm1 = np.where(off_kw > 0, pre["deg_off"], pre["deg_on"])
        wk1 = np.where(off_kw > 0, off_kw, on_kw)
        bad1 = ~(s + w1 > 0)
        s1 = np.where(bad1, solar_kw, s); w1 = np.where(bad1, wk1, w1)
        deg1 = (s1 * pre["deg_s"] + w1 * wm1) / (s1 + w1)
        bad3 = ~(s + a + o > 0)
        s3 = np.where(bad3, solar_kw, s); a3 = np.where(bad3, on_kw, a); o3 = np.where(bad3, off_kw, o)
        deg3 = (s3 * pre["deg_s"] + a3 * pre["deg_on"] + o3 * pre["deg_off"]) / (s3 + a3 + o3)
        deg = np.where(both, deg3, np.where((on_kw > 0) | (off_kw > 0), deg1, pre["deg_s"]))
        energy = energy * deg
        if pre["backup"]:
            # T095: the backup serves the full load less the renewables' degraded energy
            full = np.full_like(cf, 8760 * BASE)
            bmwh = np.maximum(0.0, full - energy)
            d = pre["diesel_capex_ann"] + bmwh * pre["diesel_fuel"] if np.isfinite(pre["diesel_fuel"]) else np.full_like(cf, np.inf)
            g = pre["gas_capex_ann"] + bmwh * pre["gas_fuel"] if (pre["gas_ok"] and np.isfinite(pre["gas_fuel"])) else np.full_like(cf, np.inf)
            b = np.where(g < d, g, d)
            out = (cost + b) / full
            out = np.where(np.isfinite(b), out, np.nan)
        else:
            out = cost / energy
            out = np.where(np.isfinite(energy) & (energy > 0), out, np.nan)
        out = np.where(cf > 0, out, np.nan)
        out = np.where(np.isfinite(out), out, np.nan)
    return out


# ---------------------------------------------------------------- data
def load(data: Path):
    man = json.loads((data / "configs.json").read_text())
    cfgs = man["configs"]
    n_cfg = len(cfgs)
    solar = np.array([c["solar"] for c in cfgs], float)
    wind = np.array([c["wind"] for c in cfgs], float)
    batt = np.array([c["batt"] for c in cfgs], float)
    off = np.array([1 if (c["wind"] > 0 and c["surface"] == "off") else 0 for c in cfgs], np.int8)
    ids = None
    cf = None
    by = {}
    for c in cfgs:
        by.setdefault(c["summary"], []).append(c)
    for f, cl in by.items():
        d = pd.read_parquet(data / f, columns=["location_id", "solar_gw", "wind_gw", "batt_gwh", "annual_cf"])
        if ids is None:
            ids = np.unique(d.location_id.values)
            cf = np.zeros((len(ids), n_cfg), np.float32)
        idx = {(c["solar"], c["wind"], c["batt"]): c["i"] for c in cl}
        ci = np.array([idx.get((s, w, b), -1) for s, w, b in zip(d.solar_gw, d.wind_gw, d.batt_gwh)])
        li = np.searchsorted(ids, d.location_id.values)
        ok = ci >= 0
        cf[li[ok], ci[ok]] = d.annual_cf.values[ok]
    unit = {"solar": next(c["i"] for c in cfgs if c["batt"] == 0 and c["solar"] == 1 and c["wind"] == 0),
            "on": next(c["i"] for c in cfgs if c["batt"] == 0 and c["solar"] == 0 and c["wind"] == 1 and c["surface"] == "on"),
            "off": next(c["i"] for c in cfgs if c["batt"] == 0 and c["solar"] == 0 and c["wind"] == 1 and c["surface"] == "off")}
    return dict(ids=ids, cf=cf, solar=solar, wind=wind, batt=batt, off=off, unit=unit, n_cfg=n_cfg)


def load_addon(data: Path, ids):
    import pyarrow.parquet as pq
    man = json.loads((data / "addon.json").read_text())
    out = {}
    for s in man["sets"]:
        p = data / s["file"]
        if hashlib.sha256(p.read_bytes()).hexdigest() != s["sha256"]:
            raise SystemExit(f"{s['file']}: SHA-256 differs from addon.json")
        d = pq.read_table(p).to_pandas()
        regs = np.unique(d.location_id.values)
        n = len(s["configs"])
        # sorted by cfg then location: reshape to (cfg, region)
        cf = d.annual_cf.values.reshape(n, len(regs)).T.copy()
        cu = d.curtailed_share.values.reshape(n, len(regs)).T.copy()
        assert np.array_equal(d.location_id.values[:len(regs)], regs)
        pos = {int(r): k for k, r in enumerate(regs)}
        cfgs = s["configs"]
        out[s["id"]] = dict(pos=pos, cf=cf, curt=cu, configs=cfgs,
                            solar=np.array([c["solar"] for c in cfgs], float),
                            batt=np.array([c["batt"] for c in cfgs], float),
                            on=np.array([c.get("on", 0) for c in cfgs], float),
                            off=np.array([c.get("off", 0) for c in cfgs], float))
    if "large" in out:
        L = out["large"]
        L["levels"] = []
        for s in sorted(set(L["solar"].tolist()), key=lambda x: list(L["solar"]).index(x)):
            js = np.where(L["solar"] == s)[0]
            L["levels"].append((s, js))
    return man, out


# ---------------------------------------------------------------- search
def pre_for(params, mult, lookups, lid, ucf):
    k = str(int(lid))
    g = lambda name: (lookups.get(name) or {}).get(k)
    lw = g("waccByLocation")
    diesel = g("dieselByLocation") or {}
    gas = g("gasByLocation") or {}
    diesel = {"rawPrice": diesel.get("rawPrice", diesel.get("price"))} if diesel else None
    gas = {"available": gas.get("available"), "rawPrice": gas.get("rawPrice", gas.get("price"))} if gas else None
    return C.precompute(params, mult, lw if isinstance(lw, (int, float)) else None, g("localCapexByLocation"),
                        diesel, gas, g("windWaccByLocation"), ucf)


def search_location(M, li, lid, pre, params, key, addon, use_addon):
    """One location, vectorised; candidates in tie-break order (dense configs, then
    wind_mix by j, then large by solar level, interpolated before its grid point).
    np.argmin/argmax return the first extreme, which is the sequential strict rule."""
    target_mode = key["type"] == "COMPUTE_BEST_LCOE"
    include_off = params.get("includeOffshore") is not False
    on_d = np.where(M["off"] == 1, 0.0, M["wind"]); off_d = np.where(M["off"] == 1, M["wind"], 0.0)
    cf_d = M["cf"][li].astype(np.float64)
    l_d = lcoe_vec(pre, cf_d, M["solar"], M["batt"], on_d, off_d)
    if not include_off:
        l_d = np.where(M["off"] == 1, np.nan, l_d)
    parts = [dict(kind=np.zeros(M["n_cfg"], np.int8), j=np.arange(M["n_cfg"]), s=M["solar"], b=M["batt"], on=on_d, off=off_d,
                  cf=cf_d, l=l_d, interp=np.zeros(M["n_cfg"], bool))]
    T_given = key["payload"].get("targetCf")
    # T067 (T065-V-2): the app compares float32 CFs with Math.fround(target), so a build
    # exactly at the target meets it; the add-on search gets the same float32 target.
    T = float(np.float32(T_given)) if T_given is not None else None
    if use_addon:
        W = addon.get("wind_mix")
        if W is not None and include_off and int(lid) in W["pos"]:
            r = W["pos"][int(lid)]
            wc = W["cf"][r].astype(np.float64)
            n = len(wc)
            parts.append(dict(kind=np.ones(n, np.int8), j=np.arange(n), s=W["solar"], b=W["batt"], on=W["on"], off=W["off"],
                              cf=wc, l=lcoe_vec(pre, wc, W["solar"], W["batt"], W["on"], W["off"]), interp=np.zeros(n, bool)))
        Lg = addon.get("large")
        if Lg is not None and int(lid) in Lg["pos"]:
            r = Lg["pos"][int(lid)]
            js_all, s_all, b_all, cf_all, it_all = [], [], [], [], []
            for s_, js in Lg["levels"]:
                c = Lg["cf"][r, js].astype(np.float64)
                b = Lg["batt"][js]
                k = None
                if target_mode and np.any(c >= T):
                    k = int(np.argmax(c >= T))
                for q, j in enumerate(js):
                    if target_mode and k is not None and q == k and k > 0 and c[k - 1] < T:
                        Tg = min(T + GUARD, c[k])
                        frac = (Tg - c[k - 1]) / (c[k] - c[k - 1])
                        js_all.append(j); s_all.append(s_); b_all.append(b[k - 1] + frac * (b[k] - b[k - 1]))
                        cf_all.append(T); it_all.append(True)
                    if target_mode and not (c[q] >= T):
                        continue
                    js_all.append(j); s_all.append(s_); b_all.append(b[q]); cf_all.append(c[q]); it_all.append(False)
            if js_all:
                n = len(js_all)
                sa, ba, ca = np.array(s_all, float), np.array(b_all, float), np.array(cf_all, float)
                parts.append(dict(kind=np.full(n, 2, np.int8), j=np.array(js_all), s=sa, b=ba, on=np.zeros(n), off=np.zeros(n),
                                  cf=ca, l=lcoe_vec(pre, ca, sa, ba, np.zeros(n), np.zeros(n)), interp=np.array(it_all)))
    A = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    ok = ~np.isnan(A["l"])
    if not ok.any():
        return None
    nowind = (A["on"] + A["off"]) == 0
    INF = np.inf

    def cand(i):
        return (int(A["kind"][i]), int(A["j"][i]), float(A["s"][i]), float(A["b"][i]), float(A["on"][i]), float(A["off"][i]),
                float(A["cf"][i]), float(A["l"][i]), bool(A["interp"][i]))

    def argbest_fb(mask):
        if not mask.any():
            return None
        cfm = np.where(mask, A["cf"], -INF)
        top = cfm.max()
        lm = np.where(mask & (A["cf"] == top), A["l"], INF)
        return int(np.argmin(lm))

    if target_mode:
        meet = ok & (A["cf"] >= T)
        lm = np.where(meet, A["l"], INF)
        best = int(np.argmin(lm)) if meet.any() else None
        lmn = np.where(meet & nowind, A["l"], INF)
        bestnw = int(np.argmin(lmn)) if (meet & nowind).any() else None
        in_fb = ok & (A["kind"] != 2)
        fb = argbest_fb(in_fb)
        if fb is None:
            return None
        fbnw = argbest_fb(in_fb & nowind)
        second = None
        if best is not None and meet.sum() > 1:
            l2 = lm.copy(); l2[best] = INF
            second = float(l2.min())
        ch = best if best is not None else fb
        c = cand(ch)
        row = row_of(lid, c, pre)
        row["meetsTarget"] = best is not None
        row["targetCf"] = T_given
        f = cand(fb)
        row["maxConfigSolar"] = f[2]; row["maxConfigWind"] = f[4] + f[5]; row["maxConfigBatt"] = f[3]
        row["maxConfigLcoe"] = f[7]; row["maxConfigWindOn"] = f[4]; row["maxConfigWindOff"] = f[5]
        row["maxConfigSurface"] = surface_of(f)
        nwi = bestnw if bestnw is not None else fbnw
        nw = cand(nwi) if nwi is not None else None
        row["noWindLcoe"] = nw[7] if nw is not None else None
        row["noWindMeetsTarget"] = bestnw is not None
        row["windSaving"] = (nw[7] - row["lcoe"]) if (nw is not None and np.isfinite(row["lcoe"]) and np.isfinite(nw[7])) else None
        row["near_tie"] = bool(best is not None and second is not None and np.isfinite(second)
                               and abs(second - c[7]) <= 1e-9 * abs(c[7]))
        row["_key"] = (c[0], c[1], c[8], f[0], f[1], nw[0] if nw else None, nw[1] if nw else None, nw[8] if nw else None)
        row["_nw"] = nw          # the no-wind build (report use; not written)
        return row
    TL = key["payload"]["targetLcoe"]
    firm = np.ones_like(A["cf"]) if pre["backup"] else np.clip(A["cf"], 0, 1)
    within = ok & (A["l"] <= TL)
    if within.any():
        fm = np.where(within, firm, -INF)
        top = fm.max()
        ch = int(np.argmin(np.where(within & (firm == top), A["l"], INF)))
    else:
        ch = int(np.argmin(np.where(ok, A["l"], INF)))
    c = cand(ch)
    row = row_of(lid, c, pre)
    row["meetsTarget"] = bool(within.any())
    row["targetLcoe"] = TL
    row["cf"] = 1.0 if pre["backup"] else max(0.0, min(1.0, c[6]))
    row["targetLcoeMet"] = bool(within.any())
    row["near_tie"] = False
    row["_key"] = (c[0], c[1], c[8])
    return row


def surface_of(c):
    on, off = c[4], c[5]
    if on > 0 and off > 0:
        return "both"
    return "off" if off > 0 else "on"


KIND = {0: None, 1: "wind_mix", 2: "large"}


def row_of(lid, c, pre):
    kind, j, s, b, on, off, cfv, lc, interp = c
    # the chosen row's LCOE is recomputed as computeLcoeMetrics does (same expressions)
    lc2 = C.lcoe_full(pre, cfv, s, b, on, off)
    return {"location_id": int(lid), "solar_gw": s, "wind_gw": on + off, "wind_surface": surface_of(c),
            "wind_on_gw": on, "wind_off_gw": off, "batt_gwh": b, "annual_cf": cfv, "lcoe": lc2,
            "addon": KIND[kind], "interpolated": bool(interp),
            "windShare": ((on + off) / (s + on + off)) if (s + on + off) > 0 else 0.0}


def run_key(M, addon, key, lookups, use_addon):
    params = key["payload"]["params"]
    mult = key["payload"]["costMultipliers"]
    rows = {}
    uc = M["cf"][:, [M["unit"]["solar"], M["unit"]["on"], M["unit"]["off"]]].astype(np.float64)
    for li, lid in enumerate(M["ids"]):
        pre = pre_for(params, mult, lookups, lid, {"solar": uc[li, 0], "on": uc[li, 1], "off": uc[li, 2]})
        r = search_location(M, li, lid, pre, params, key, addon, use_addon)
        if r is not None:
            rows[int(lid)] = r
    return rows


def classify(base, new):
    ch = []
    if base["_key"][:3] != new["_key"][:3]:
        ch.append("winner" if new.get("meetsTarget") else "fallback")
    if len(base["_key"]) > 3:
        if base["_key"][3:5] != new["_key"][3:5]:
            ch.append("maxconfig")
        if base["_key"][5:] != new["_key"][5:]:
            ch.append("nowind")
    return ch


def bisect_interpolated(rows_by_key, addon, steps=40):
    """For every interpolated large winner: the true minimum battery reaching T, by
    bisection on the simulation itself (repeating year, as the file), bounded to the
    winner's bracket. Adds `b_true` and `bracket` to the row; returns violations
    (b* < b_true - 1e-6 GWh)."""
    Lg = addon["large"]
    jobs = []
    for k, rows in rows_by_key.items():
        for r in rows:
            if r["interpolated"]:
                rr = Lg["pos"][r["location_id"]]
                js = [js for s_, js in Lg["levels"] if s_ == r["solar_gw"]][0]
                c = Lg["cf"][rr, js].astype(np.float64)
                kk = int(np.argmax(c >= r["annual_cf"]))
                r["bracket"] = [float(Lg["batt"][js[kk - 1]]), float(Lg["batt"][js[kk]])]
                jobs.append(r)
    if not jobs:
        return 0, 0
    ids, solar_all = C.load_solar()
    locs = np.array([r["location_id"] for r in jobs])
    u = np.unique(locs)
    sol = np.ascontiguousarray(solar_all[np.searchsorted(ids, u)])
    row_loc = np.searchsorted(u, locs)
    lo = np.array([r["bracket"][0] for r in jobs]); hi = np.array([r["bracket"][1] for r in jobs])
    T = np.array([r["annual_cf"] for r in jobs]); S = np.array([r["solar_gw"] for r in jobs], float)
    zero = np.zeros_like(sol)
    for _ in range(steps):
        mid = 0.5 * (lo + hi)
        cf = C.simulate_rows(sol, zero, row_loc, S, np.zeros(len(jobs)), mid, cyclic=True)
        okm = cf >= T
        hi = np.where(okm, mid, hi); lo = np.where(okm, lo, mid)
    bad = 0
    for r, bt in zip(jobs, hi):
        r["b_true"] = float(bt)
        bad += int(r["batt_gwh"] < bt - 1e-6)
    return len(jobs), bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--dump", type=Path, required=True)
    ap.add_argument("--drawn", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--keys", default="")
    ap.add_argument("--no-bisect", action="store_true")
    args = ap.parse_args()
    dump = json.loads(args.dump.read_text())
    drawn = json.loads(args.drawn.read_text())
    M = load(args.data)
    man, addon = load_addon(args.data, M["ids"])
    keys = [k for k in dump["keys"] if not args.keys or k in args.keys.split(",")]
    sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    try:
        git = subprocess.run(["git", "-C", str(C.REPO), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    except Exception:
        git = None
    out = {"meta": {"addon_json_sha256": sha(args.data / "addon.json"),
                    "addon_files": {s["file"]: s["sha256"] for s in man["sets"]},
                    "data_sha256": {p.name: sha(p) for p in sorted(args.data.glob("summary_*.parquet"))} | {"configs.json": sha(args.data / "configs.json")},
                    "params_dump_sha256": sha(args.dump), "oracle": "pipeline/scripts/pipeline/addon/oracle.py", "git": git},
           "keys": {}}
    failed = False
    for k in keys:
        key = dump["keys"][k]
        lk = dump["lookups"][key["lookups"]]
        view = key["view"]
        base = run_key(M, addon, key, lk, use_addon=False)
        new = run_key(M, addon, key, lk, use_addon=True)
        bd = sorted(digest(r, view) for r in base.values())
        nd = sorted(digest(r, view) for r in new.values())
        same = bd == sorted(drawn[k])
        nd_diff = sum(1 for a, b in zip(sorted(drawn[k]), bd) if a != b)
        print(f"{k}: base digest {'EQUALS' if same else f'DIFFERS FROM ({nd_diff} rows)'} the app's add-on-off draw ({len(bd)} rows)")
        if not same:
            failed = True
            dd = [(a, b) for a, b in zip(sorted(drawn[k]), bd) if a != b][:5]
            for a, b in dd:
                print(f"    app {a}\n    orc {b}")
        rows = []
        counts = {"wind_mix_winners": 0, "large_winners": 0, "large_interpolated": 0, "nowind_only": 0,
                  "maxconfig_only": 0, "fallback": 0, "changed": 0, "near_tie": 0, "rows": len(new)}
        for lid, r in new.items():
            b = base[lid]
            c = classify(b, r)
            r = {kk: (None if isinstance(v, float) and not np.isfinite(v) else v) for kk, v in r.items() if not kk.startswith("_")}
            r["change"] = c
            rows.append(r)
            if r["addon"] == "wind_mix" and "winner" in c: counts["wind_mix_winners"] += 1
            if r["addon"] == "large" and "winner" in c:
                counts["large_winners"] += 1
                counts["large_interpolated"] += int(r["interpolated"])
            if c == ["nowind"]: counts["nowind_only"] += 1
            if c == ["maxconfig"]: counts["maxconfig_only"] += 1
            if "fallback" in c: counts["fallback"] += 1
            counts["changed"] += int(bool(c))
            counts["near_tie"] += int(r["near_tie"])
        out["keys"][k] = {"view": view, "base_digest": bd, "digest": nd, "rows": rows, "counts": counts}
        print(f"    with the add-on: {counts}")
        if not args.no_bisect:
            n_i, bad = bisect_interpolated({k: rows}, addon)
            counts["interpolated_checked"] = n_i; counts["interpolated_below_true"] = bad
            print(f"    interpolated winners checked by bisection: {n_i}, below the true minimum: {bad}")
            failed |= bad > 0
    args.out.parent.mkdir(parents=True, exist_ok=True)
    # mtime 0 and no file name in the gzip header: the same inputs give the same bytes
    with open(args.out, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as f:
        f.write(json.dumps(out, separators=(",", ":")).encode())
    print(f"wrote {args.out} ({args.out.stat().st_size / 1e6:.1f} MB)")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
