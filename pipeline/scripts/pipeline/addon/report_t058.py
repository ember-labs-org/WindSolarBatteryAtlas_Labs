"""T058 before/after page: team/reports/T058-before-after.html.

Every number comes from the oracle's own search (oracle.py run_key, add-on off vs
on, with the params the app sent for each key: params_dump.json.gz), the data in
deployment/data and the view measurements (measure_views.mjs, main vs the app
branch). The search rows are first checked against checks/addon_oracle.json.gz
(digests equal) so the page and the checks describe the same results.

  T058_OUT=<scratch> python3 -I report_t058.py --data <repo>/deployment/data \
      --views-main <json> --views-app <json> --out <repo>/team/reports/T058-before-after.html
"""
from __future__ import annotations

import argparse
import gzip
import html
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
import pandas as pd

import common as C
import oracle as O

HERE = Path(__file__).resolve().parent
KEYS = [("lcoe_t80", "80%"), ("lcoe_t90", "90%"), ("lcoe_t99", "99%")]
PLACES = [  # (label, lat, lon): the region whose site is nearest
    ("Tromsø, northern Norway", 69.65, 18.96), ("Finnmark, northern Norway", 70.0, 25.0),
    ("Kiruna, northern Sweden", 67.86, 20.23), ("Rovaniemi, northern Finland", 66.50, 25.73),
    ("Oulu, Finland", 65.01, 25.47), ("Reykjavík, Iceland", 64.15, -21.94),
    ("Inverness, Scotland", 57.48, -4.22),
    ("Fairbanks, Alaska", 64.84, -147.72), ("Anchorage, Alaska", 61.22, -149.90),
    ("Yellowknife, Canada", 62.45, -114.37), ("Whitehorse, Canada", 60.72, -135.06),
    ("Iqaluit, Canada", 63.75, -68.52), ("Murmansk, Russia", 68.97, 33.08),
    ("Arkhangelsk, Russia", 64.54, 40.54), ("Norilsk, Russia", 69.35, 88.20),
    ("Yakutsk, Russia", 62.03, 129.73), ("Helsinki, Finland", 60.17, 24.94),
    ("Oslo, Norway", 59.91, 10.75), ("Edinburgh, Scotland", 55.95, -3.19)]


def fmt(n, d=0):
    return f"{n:,.{d}f}"


def money(v):
    return "–" if v is None or not np.isfinite(v) else f"${v:,.0f}"


def pct(v):
    if abs(v) < 0.05:
        return "−0.0%" if v < 0 else "0.0%"
    return f"{v:.1f}%".replace("-", "−")


def dollars(v, d=1):
    return ("−" if v < 0 else "") + f"${abs(v):,.{d}f}"


def people(p):
    return f"{p / 1e9:.2f} bn" if p >= 1e9 else f"{p / 1e6:.1f} m" if p >= 1e5 else f"{p:,.0f}"


def build_str(r, nw=False):
    s, b = r["solar_gw"], r["batt_gwh"]
    bt = f"{b:,.0f} MWh" + (" (interpolated)" if r.get("interpolated") else "")
    if r["wind_surface"] == "both":
        return f"solar {s:g} + onshore {r['wind_on_gw']:g} + offshore {r['wind_off_gw']:g} MW, battery {b:g} MWh"
    if r["wind_gw"]:
        return f"solar {s:g} + {'offshore' if r['wind_surface'] == 'off' else 'onshore'} wind {r['wind_gw']:g} MW, battery {b:g} MWh"
    return f"solar {s:g} MW, battery {bt}"


def nw_build(c):
    if c is None:
        return "–"
    kind, j, s, b, on, off, cfv, lc, interp = c
    return f"solar {s:g} MW, battery {b:,.0f} MWh" + (" (interpolated)" if interp else "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--views-main", type=Path, required=True)
    ap.add_argument("--views-app", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    D = args.data
    dump = json.loads(gzip.decompress((HERE / "params_dump.json.gz").read_bytes()))
    orc = json.loads(gzip.decompress((C.REPO / "checks/addon_oracle.json.gz").read_bytes()))
    M = O.load(D)
    man, addon = O.load_addon(D, M["ids"])

    oc = pd.read_csv(D / "voronoi_overlapping_countries.csv").set_index("location_id")
    pts = pd.read_parquet(D / "summary_w0.parquet", columns=["location_id", "latitude", "longitude"]).drop_duplicates("location_id").set_index("location_id")
    pop = pd.read_csv(D / "voronoi_population_2020.csv")
    k2 = lambda la, lo: np.round(np.asarray(la, float), 2).astype(str).astype(object) + "," + np.round(np.asarray(lo, float), 2).astype(str)
    pm = dict(zip(k2(pop.latitude, pop.longitude), pop.population_2020))
    P = pd.Series([pm.get(x, 0.0) for x in k2(pts.latitude, pts.longitude)], index=pts.index)
    res = pd.read_csv(D / "voronoi_wind_resource.csv").set_index("location_id")
    country = lambda lid: oc.loc[lid, "country_name"] if lid in oc.index else "?"
    where = lambda lid: f"{country(lid)} ({pts.loc[lid, 'latitude']:.1f}°, {pts.loc[lid, 'longitude']:.1f}°)"

    R = {}
    for k in [k for k, _ in KEYS] + ["lcoe_cf_default"]:
        key = dump["keys"][k]
        lk = dump["lookups"][key["lookups"]]
        base = O.run_key(M, addon, key, lk, use_addon=False)
        new = O.run_key(M, addon, key, lk, use_addon=True)
        view = key["view"]
        assert sorted(O.digest(r, view) for r in base.values()) == orc["keys"][k]["base_digest"], k
        assert sorted(O.digest(r, view) for r in new.values()) == orc["keys"][k]["digest"], k
        R[k] = (base, new)
        print(f"{k}: rows match checks/addon_oracle.json.gz")

    sec = []
    # ---- headline table per target
    rows_html = []
    summary = {}
    for k, lab in KEYS:
        base, new = R[k]
        ch = [lid for lid in new if O.classify(base[lid], new[lid]) and new[lid]["addon"] and "winner" in O.classify(base[lid], new[lid])]
        wm = [l for l in ch if new[l]["addon"] == "wind_mix"]
        lg = [l for l in ch if new[l]["addon"] == "large"]
        li = [l for l in lg if new[l]["interpolated"]]
        newly = [l for l in lg if not base[l]["meetsTarget"]]
        newly_wm = [l for l in wm if not base[l]["meetsTarget"]]
        def chg(ls):
            both = [l for l in ls if base[l]["meetsTarget"]]
            if not both:
                return "–", "–"
            d = np.array([new[l]["lcoe"] - base[l]["lcoe"] for l in both])
            pc = np.array([new[l]["lcoe"] / base[l]["lcoe"] - 1 for l in both]) * 100
            return (f"{pct(np.median(pc))} ({dollars(np.median(d))})",
                    f"{pct(pc.min())} to {pct(pc.max())}")
        m_wm, r_wm = chg(wm); m_lg, r_lg = chg(lg)
        summary[k] = dict(wm=len(wm), lg=len(lg), li=len(li), newly=len(newly), ppl_wm=P.loc[wm].sum(), ppl_lg=P.loc[lg].sum(),
                          ppl_newly=P.loc[newly].sum(), newly_wm=len(newly_wm))
        rows_html.append(f"<tr><td>{lab}</td><td class=n>{len(wm)}</td><td class=n>{people(P.loc[wm].sum())}</td><td class=n>{m_wm}</td><td class=n>{r_wm}</td>"
                         f"<td class=n>{len(lg)} ({len(li)} / {len(lg) - len(li)})</td><td class=n>{len(newly)}</td><td class=n>{m_lg}</td><td class=n>{r_lg}</td></tr>")
    # budget
    base, new = R["lcoe_cf_default"]
    TL = dump["keys"]["lcoe_cf_default"]["payload"]["targetLcoe"]
    chb = [l for l in new if O.classify(base[l], new[l])]
    up = np.array([new[l]["cf"] - base[l]["cf"] for l in chb]) * 100
    kinds = pd.Series([new[l]["addon"] or "dense" for l in chb]).value_counts().to_dict()
    sec.append(f"""<h2>How many regions change build</h2>
<p>The cost map picks, for every region, the cheapest build that keeps a constant 1 GW load supplied for the chosen share of the year.
With the add-on it can also pick a combined onshore + offshore wind build, or a solar + battery build beyond the sliders.
A region changes only where one of those is strictly cheaper; everywhere else the result is exactly today's (checked row by row).</p>
<div class=wrap><table><tr><th>Uptime target</th><th class=n>Combined wind wins</th><th class=n>People there</th><th class=n>Cost change, median</th><th class=n>Range</th>
<th class=n>Large solar + battery wins (interpolated / simulated)</th><th class=n>…of which could not reach the target before</th><th class=n>Cost change, median</th><th class=n>Range</th></tr>
{''.join(rows_html)}</table></div>
<p class=note>Cost change is the new cheapest build's cost against today's, for regions that reached the target both ways. Regions that could not reach the target before have no earlier cost to compare.</p>
<p>At 99%, {summary['lcoe_t99']['newly']} regions ({people(summary['lcoe_t99']['ppl_newly'])}) could not reach the target with any build within the sliders, wind included; a large solar + battery build is now their cheapest, at a cost shown in the next sections.
Combined wind brings {summary["lcoe_t99"]["newly_wm"]} more region{"" if summary["lcoe_t99"]["newly_wm"] == 1 else "s"} to 99% that could not get there before.</p>
<p><b>Cost-budget map</b> (highest uptime within ${TL:g}/MWh): {len(chb)} regions change build{' – all to a combined wind build' if list(kinds) == ['wind_mix'] else ' (' + ', '.join(f'{v} {k}' for k, v in kinds.items()) + ')'}; uptime rises by a median {np.median(up):.2f} points (range {up.min():.2f} to {up.max():.2f}).
No large solar + battery build fits a ${TL:g} budget anywhere.</p>""")

    # ---- no-wind costs newly available
    nw_rows = []
    for k, lab in KEYS:
        base, new = R[k]
        nl = [l for l in new if not base[l]["noWindMeetsTarget"] and new[l]["noWindMeetsTarget"]]
        cheaper = [l for l in new if base[l]["noWindMeetsTarget"] and new[l]["noWindLcoe"] < base[l]["noWindLcoe"] - 1e-9]
        cost = np.array([new[l]["noWindLcoe"] for l in nl])
        ws = np.array([new[l]["windSaving"] for l in nl if new[l]["windSaving"] is not None])
        nw_rows.append(f"<tr><td>{lab}</td><td class=n>{len(nl)}</td><td class=n>{people(P.loc[nl].sum())}</td>"
                       f"<td class=n>{money(np.median(cost)) if len(cost) else '–'}</td><td class=n>{money(np.percentile(cost, 10)) if len(cost) else '–'} – {money(np.percentile(cost, 90)) if len(cost) else '–'}</td>"
                       f"<td class=n>{money(np.median(ws)) if len(ws) else '–'}</td><td class=n>{len(cheaper)}</td></tr>")
        summary[k]["nw_new"] = len(nl); summary[k]["nw_ppl"] = P.loc[nl].sum()
    sec.append(f"""<h2>Solar + battery costs where there were none (decision D-126)</h2>
<p>Today, a region whose solar + battery builds within the sliders cannot reach the target shows no solar-only cost, and the wind-saving map paints it "wind needed".
The large builds now give those regions a solar + battery cost: the cheapest build that does reach the target, however large.
The wind-saving map then shows how much wind saves there instead of "wind needed".</p>
<div class=wrap><table><tr><th>Uptime target</th><th class=n>Regions newly with a solar + battery cost</th><th class=n>People</th><th class=n>That cost, median</th><th class=n>10th – 90th percentile</th><th class=n>Wind saving shown, median</th><th class=n>Regions whose solar + battery cost falls</th></tr>
{''.join(nw_rows)}</table></div>
<p class=note>"Falls" counts regions that already had a solar + battery cost and now find a cheaper one beyond the sliders.</p>""")

    # ---- named northern places at 99%
    base, new = R["lcoe_t99"]
    lat = pts.latitude.values; lon = pts.longitude.values
    pl_rows = []
    seen = set()
    for lab, la, lo in PLACES:
        d = (lat - la) ** 2 + ((lon - lo) * np.cos(np.radians(la))) ** 2
        lid = int(pts.index[int(np.argmin(d))])
        if lid in seen or lid not in new:
            continue
        seen.add(lid)
        b, n = base[lid], new[lid]
        before = money(b["noWindLcoe"]) if b["noWindMeetsTarget"] else "none (cannot reach 99%)"
        after = money(n["noWindLcoe"]) if n["noWindMeetsTarget"] else "none"
        wb = money(b["lcoe"]) if b["meetsTarget"] else "cannot reach"
        pl_rows.append(f"<tr><td>{html.escape(lab)}</td><td class=n>{lid}</td><td class=n>{people(P.loc[lid])}</td><td class=n>{before}</td>"
                       f"<td class=n>{after}</td><td>{nw_build(n.get('_nw')) if n['noWindMeetsTarget'] else '–'}</td>"
                       f"<td class=n>{wb}</td><td class=n>{money(n['lcoe'])}</td><td>{build_str(n)}</td></tr>")
    sec.append(f"""<h2>The north at 99% uptime</h2>
<p>The cheapest build with solar and batteries only, before and after, and for comparison the cheapest build of all (wind allowed), before and now. Each place is the region whose centre is nearest to it.
Before, no region here could reach 99% with solar and batteries within the sliders: the polar winter is too long for 36 MWh of storage. Where the region's wind is weak (Oslo, Anchorage, Whitehorse, Yakutsk) no build at all reached 99%, and the large solar + battery build is now the only one that does.</p>
<div class=wrap><table><tr><th>Place</th><th class=n>Region</th><th class=n>People</th><th class=n>Solar + battery, before</th><th class=n>Solar + battery, now</th><th>That build (per MW of load)</th><th class=n>Cheapest with wind, before</th><th class=n>Cheapest of all, now</th><th>That build</th></tr>
{''.join(pl_rows)}</table></div>
<p class=note>All costs in $ per MWh at the app's defaults (global capital costs and cost of capital, 2026, no backup). "Interpolated": the battery lies between two simulated sizes and is rounded up (see Caveats).</p>""")

    # ---- combined wind examples
    ex_html = []
    for k, lab in (("lcoe_t90", "90%"), ("lcoe_t99", "99%")):
        base, new = R[k]
        wm = [l for l in new if new[l]["addon"] == "wind_mix" and base[l]["meetsTarget"]]
        wm.sort(key=lambda l: new[l]["lcoe"] / base[l]["lcoe"])
        top = sorted(wm, key=lambda l: -P.loc[l])[:4] + [l for l in wm[:4]]
        done = []
        items = []
        for l in top:
            if l in done:
                continue
            done.append(l)
            b, n = base[l], new[l]
            items.append(f"<tr><td>{lab}</td><td>{html.escape(where(l))}</td><td class=n>{people(P.loc[l])}</td><td>{build_str(b)}</td><td class=n>{money(b['lcoe'])}</td>"
                         f"<td>{build_str(n)}</td><td class=n>{money(n['lcoe'])}</td><td class=n>{(n['lcoe'] / b['lcoe'] - 1) * 100:.1f}%</td></tr>")
        ex_html += items
        cc = pd.Series([country(l) for l in wm]).value_counts().head(6)
        ex_html.append(f"<tr><td colspan=8 class=note>{lab}: {len(wm)} regions; most in {', '.join(f'{c} {v}' for c, v in cc.items())}.</td></tr>")
    sec.append(f"""<h2>Where combined onshore + offshore wins</h2>
<p>Combined builds exist only in the {man['sets'][0]['regions']:,} regions with both eligible land and sea, for onshore 1–4 and offshore 1–3 MW per MW of load (total at most 5).
They win where offshore wind fills hours when onshore wind is calm, mostly at high uptime targets. The table shows the most populous winners and the biggest savings.</p>
<div class=wrap><table><tr><th>Target</th><th>Region</th><th class=n>People</th><th>Before</th><th class=n>Cost</th><th>Now</th><th class=n>Cost</th><th class=n>Change</th></tr>
{''.join(ex_html)}</table></div>""")

    # ---- download and memory
    vm = json.loads(args.views_main.read_text()); va = json.loads(args.views_app.read_text())
    mrows = []
    for sm, sa in zip(vm["steps"], va["steps"]):
        wmain = sum(w.get("backingMb") or 0 for w in sm["workers"]) + sum(w.get("usedMb") or 0 for w in sm["workers"])
        wapp = sum(w.get("backingMb") or 0 for w in sa["workers"]) + sum(w.get("usedMb") or 0 for w in sa["workers"])
        mmain = (sm["main"]["usedMb"] or 0) + (sm["main"]["backingMb"] or 0)
        mapp = (sa["main"]["usedMb"] or 0) + (sa["main"]["backingMb"] or 0)
        label = sa["step"].split(" (offshore")[0]
        mrows.append(f"<tr><td>{html.escape(label)}</td><td class=n>{sm['bytesMb']:.1f}</td><td class=n>{sa['bytesMb']:.1f}</td>"
                     f"<td class=n>{wmain:.0f}</td><td class=n>{wapp:.0f}</td><td class=n>{mmain:.0f}</td><td class=n>{mapp:.0f}</td>"
                     f"<td class=n>{sm['renderer']['footprintMb']}</td><td class=n>{sa['renderer']['footprintMb']}</td></tr>")
    files = {s["file"]: (D / s["file"]).stat().st_size for s in man["sets"]}
    def mem(st, part):
        if part == "worker":
            return sum((w.get("backingMb") or 0) + (w.get("usedMb") or 0) for w in st["workers"])
        return (st["main"]["usedMb"] or 0) + (st["main"]["backingMb"] or 0)
    sm, sa = vm["steps"], va["steps"]
    d_fetch_cost = sa[1]["bytesMb"] - sm[1]["bytesMb"]; d_fetch_comb = sa[2]["bytesMb"] - sm[2]["bytesMb"]
    d_w = mem(sa[1], "worker") - mem(sm[1], "worker")
    d_main_comb = mem(sa[2], "main") - mem(sm[2], "main"); d_main_sd = mem(sa[3], "main") - mem(sm[3], "main")
    comb_files = sa[2]["files"]
    refetch = comb_files.get("/data/addon_wind_mix.parquet", 0) / 1e6
    grow = (f"the cost view fetches the two add-on files ({d_fetch_cost:+.1f} MB) and its worker holds {d_w:+.0f} MB (the add-on arrays next to the 58 MB cost grid). "
            f"The combined capacity view fetches {d_fetch_comb:+.1f} MB against main's offshore-only view"
            + (f", including the combined-wind file again ({refetch:.1f} MB)" if refetch else ", with no second fetch of the combined-wind file (its rows come from the worker)")
            + f", and holds {d_main_comb:+.0f} MB on the main thread; after leaving it (Sample Days row) the difference is {d_main_sd:+.0f} MB.")
    sec.append(f"""<h2>Download size and memory</h2>
<p>Measured in Chromium on this laptop, one view after another in one page, main (69002b1) against the add-on branch (task/T058-app {va.get('git', '463ca61')}).
"Fetched" counts every byte the page and its workers requested in that step, with the browser cache off; the parquet decoder (6.6 MB) is fetched again by each short-lived loader, which a normal browser serves from its cache.
Memory is JavaScript heap plus typed-array storage (the cost grid and the add-on arrays), after garbage collection; "renderer" is the whole tab process (macOS footprint) and moves with the operating system.</p>
<div class=wrap><table><tr><th>Step</th><th class=n>Fetched, MB: main</th><th class=n>add-on</th><th class=n>Cost worker, MB: main</th><th class=n>add-on</th><th class=n>Page (main thread), MB: main</th><th class=n>add-on</th><th class=n>Renderer, MB: main</th><th class=n>add-on</th></tr>
{''.join(mrows)}</table></div>
<p>The add-on files are {files['addon_wind_mix.parquet'] / 1e6:.2f} MB (combined wind) and {files['addon_large.parquet'] / 1e6:.2f} MB (large builds), plus {(D / 'addon.json').stat().st_size / 1e3:.0f} kB of manifest, next to {sum(p.stat().st_size for p in D.glob('summary_*.parquet')) / 1e6:.1f} MB of existing result files.
In main, the "combined" step can only show offshore 1 (raising one wind slider sets the other to 0).</p>
<p><b>What grows:</b> {grow}</p>""")

    # ---- caveats
    sec.append("""<h2>Caveats</h2>
<ul>
<li><b>The large builds use a repeating year.</b> Their battery starts January with what it held at the end of December, so storage can carry summer sun into the polar night. Every build within the sliders still starts January with an empty battery, as before. Seasonal battery storage at this scale (thousands of MWh per MW of load) is a thought experiment, not a proposal.</li>
<li><b>The battery is interpolated, always upwards.</b> Between two simulated battery sizes the app draws a straight line and rounds the battery up, so the cost it shows is never below what the simulation gives (checked against an exact search for every interpolated result).</li>
<li><b>The cost-budget map uses simulated sizes only.</b> It never interpolates, so for the same region it can show a slightly lower uptime than the target map implies at the same cost.</li>
<li><b>The large builds go beyond the sliders.</b> Solar up to 200 MW and battery up to 4,608 MWh per MW of load, searched only in regions that cannot reach 99.9% within the sliders. They appear in the cost views only; the sliders still stop at 20 MW and 36 MWh.</li>
</ul>""")

    s99 = summary["lcoe_t99"]
    page = f"""<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Combined wind and large builds</title>
<style>
:root{{--bg:#fff;--fg:#1a1a1a;--muted:#5b6470;--line:#e3e6ea;--acc:#0b7a75}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#111416;--fg:#e8eaed;--muted:#9aa3ad;--line:#2a2f35;--acc:#4fd1c5}}}}
:root[data-theme="dark"]{{--bg:#111416;--fg:#e8eaed;--muted:#9aa3ad;--line:#2a2f35;--acc:#4fd1c5}}
body{{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px}}
main{{max-width:1080px;margin:0 auto}} h1{{font-size:24px;margin:0 0 4px}} h2{{font-size:17px;margin:28px 0 8px;color:var(--acc)}}
p.lead{{color:var(--muted);margin:0 0 16px}} table{{border-collapse:collapse;width:100%;font-size:14px}}
th,td{{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}} td.n,th.n{{text-align:right;font-variant-numeric:tabular-nums}}
.wrap{{overflow-x:auto}} ul{{padding-left:20px}} .note{{color:var(--muted);font-size:13px}}
</style></head><body><main>
<h1>Combined onshore + offshore wind, and solar + battery builds beyond the sliders</h1>
<p class=lead>T058, decisions D-121, D-122 and D-124 to D-127. <b>Before:</b> main at 69002b1 (4,465 regions, no wind cut-off). <b>After:</b> the same data plus a sparse add-on:
combined wind for {man['sets'][0]['regions']:,} regions with both land and sea sites ({man['sets'][0]['rows']:,} simulated builds) and large solar + battery builds for {man['sets'][1]['regions']:,} regions that cannot reach 99.9% within the sliders ({man['sets'][1]['rows']:,} builds).
Nothing else changes: the existing data files are byte-identical and every existing result is reproduced exactly with the add-on switched off.
The article now uses the add-on and its reframe: wind is the cheaper route for almost nine-tenths of demand at 90% uptime, and north of 50°N solar + battery alone costs a median $276/MWh against $73 with wind.
At 99% uptime the cost map changes in {s99['wm'] + s99['lg']:,} regions ({s99['wm']} combined wind, {s99['lg']} large solar + battery), and {s99['nw_new']:,} regions ({people(s99['nw_people'] if 'nw_people' in s99 else s99['nw_ppl'])}) gain a solar + battery cost they did not have.</p>
{''.join(sec)}
<p class=note>Numbers: pipeline/scripts/pipeline/addon/report_t058.py (search rows checked against checks/addon_oracle.json.gz), measure_views.mjs for size and memory.</p>
</main></body></html>
"""
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(page)
    print(json.dumps({k: {kk: (round(vv) if isinstance(vv, float) else vv) for kk, vv in v.items()} for k, v in summary.items()}, indent=1))


if __name__ == "__main__":
    main()
