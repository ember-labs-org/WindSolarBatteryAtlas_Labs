"""T060 report: team/reports/T060-ten-year.md and T060-before-after.html.

Every figure is read from the model and analysis outputs made on deployment/data
(2024 weather) and deployment/data_10y (2015-2024 average):
  article/model_{2024,10y}.json     model.js (the article model), every value and every bound number
  article/out{24,10}/               analyse.py outputs
  article/search_{2024,10y}.npz     engine.search per region at 80/90/99% (search_dump.py)
  article/curves_{2024,10y}.json    city LCOE curves (city_curves.py)
  results/weather_*.csv             profile CFs by year (weather.py)
  results/large_sensitivity.json    warm-start sensitivity of the large builds (large_warm.py)

  python3 -I report.py <repo>
"""
from __future__ import annotations

import os
import html
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(os.environ.get("TENYEAR_ROOT", str(Path.home() / "wind-atlas-T064")))  # T064 run dir (T060: ~/wind-atlas-T060)
A = ROOT / "article"
RES = ROOT / "results"
repo = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(repo / "scripts/article"))
import analyse  # noqa: E402
wy = json.loads((ROOT / "results/worst_year.json").read_text())

m24 = json.loads((A / "model_2024.json").read_text())
m10 = json.loads((A / "model_10y.json").read_text())
v24, v10 = m24["modelValues"], m10["modelValues"]
s24 = np.load(A / "search_2024.npz", allow_pickle=False)
s10 = np.load(A / "search_10y.npz", allow_pickle=False)
assert np.array_equal(s24["ids"], s10["ids"])
t1_24 = pd.read_csv(A / "out24/take1_by_target.csv")
t1_10 = pd.read_csv(A / "out10/take1_by_target.csv")
wb = pd.read_csv(RES / "weather_by_band.csv")
wc = pd.read_csv(RES / "weather_cities.csv")
c24 = json.loads((A / "curves_2024.json").read_text())
c10 = json.loads((A / "curves_10y.json").read_text())
lsens = json.loads((RES / "large_sensitivity.json").read_text()) if (RES / "large_sensitivity.json").exists() else None
D24, D10 = repo / "deployment/data", repo / "deployment/data_10y"
YEARS = list(range(2015, 2025))


# ---------------------------------------------------------------- formats (article's format.js)
def F(v, f):
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "–"
    nf = lambda x: f"{x:,.0f}"  # noqa: E731
    return {
        "pct": lambda: f"{round(v * 100)}%", "pctnum": lambda: f"{round(v * 100)}",
        "pct1": lambda: f"{round(v * 1000) / 10:.1f}%", "usd": lambda: f"${nf(round(v))}",
        "int": lambda: nf(round(v)), "pwh": lambda: nf(round(v / 1000)), "r10": lambda: nf(round(v / 10) * 10),
        "d1": lambda: f"{round(v * 10) / 10:.1f}", "pts": lambda: f"{v * 100:.2f}",
        "corr": lambda: f"{'−' if v < 0 else ''}{abs(v):.2f}",
    }.get(f, lambda: str(v))()


def sgn(x, d=1, unit=""):
    if x is None or not math.isfinite(x):
        return "–"
    return f"{'+' if x > 0 else ('−' if x < 0 else '±')}{abs(x):.{d}f}{unit}"


def dusd(a, b, d=1):
    if a is None or b is None:
        return "–"
    x = b - a
    return f"{'+' if x > 0 else ('−' if x < 0 else '±')}${abs(x):.{d}f}"


def dpts(a, b):     # change in a share, in points
    return None if a is None or b is None else (b - a) * 100


def wmed(v, w, sel):
    return analyse.wmedian(np.where(sel, v, np.nan), np.where(sel, w, 0.0))


def sh(mask, w, sel=None):
    s = np.ones(len(w), bool) if sel is None else sel
    tot = w[s].sum()
    return float(w[s & mask].sum() / tot) if tot > 0 else None


def north(s, T, lat0=50):
    sel = s["lat"] >= lat0
    pop = s["pop"]
    meets, nwm = s[f"meets_{T}"] > 0, s[f"nowind_meets_{T}"] > 0
    both = meets & nwm & sel
    large = (s[f"nowind_large_{T}"] > 0) & nwm & sel
    return dict(
        sbStd=sh(s[f"nowind_std_meets_{T}"] > 0, pop, sel), sbReach=sh(nwm, pop, sel),
        sbBoth=wmed(s[f"nowind_lcoe_{T}"], pop, both), windBoth=wmed(s[f"lcoe_{T}"], pop, both),
        medWind=analyse.wmedian(np.where(sel, np.where(meets, s[f"lcoe_{T}"], np.inf), np.nan), np.where(sel, pop, 0)),
        lgWins=int(large.sum()), regions=int(sel.sum()),
        lgSolar=float(np.median(s[f"nowind_solar_{T}"][large])) if large.any() else None,
        lgBatt=float(np.median(s[f"nowind_batt_{T}"][large])) if large.any() else None)


def cut99(t1, W):
    r = t1[(t1.target_cf == 99) & (t1.surfaces == "onshore+offshore") & (t1.weight == W)].iloc[0]
    return float(r.median_cut_both_reach)


# ---------------------------------------------------------------- tables
def md_table(head, rows):
    out = ["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def html_table(head, rows, num_from=1):
    th = "".join(f"<th{' class=n' if i >= num_from else ''}>{html.escape(h)}</th>" for i, h in enumerate(head))
    trs = "".join("<tr>" + "".join(f"<td{' class=n' if i >= num_from else ''}>{html.escape(str(c))}</td>"
                                   for i, c in enumerate(r)) + "</tr>" for r in rows)
    return f"<div class=wrap><table><tr>{th}</tr>{trs}</table></div>"


SECTIONS = []   # (title, intro paragraphs [str], tables [(head, rows, note)], extra_html)


def section(title, paras, tables=(), extra_html="", extra_md=""):
    SECTIONS.append((title, paras, list(tables), extra_html, extra_md))


TECH = {"solar": "Solar", "wind_on": "Onshore wind", "wind_off": "Offshore wind"}

# ---------------------------------------------------------------- 1 weather
w_world = wb[wb.band == "world"].set_index("tech")
paras = []
for t in ("solar", "wind_on", "wind_off"):
    r = w_world.loc[t]
    paras.append(f"{TECH[t]}: people-weighted mean CF {r.cf_mean:.3f} over 2015–2024 against {r.cf_2024:.3f} in 2024 "
                 f"({sgn(r.dev_2024_pct, 1, '%')}); the ten years span {sgn(r.min_pct, 1, '%')} to {sgn(r.max_pct, 1, '%')} "
                 f"around the mean, and 2024 ranks {int(r.rank_2024)} of 10 (1 = best). "
                 f"Region by region the ten-year mean is a median {r.region_ratio_median:.3f}× the 2024 CF "
                 f"(10th–90th percentile {r.region_ratio_p10:.3f}–{r.region_ratio_p90:.3f}); 2024 was above the region's mean "
                 f"in {r.regions_2024_above_mean_pct:.0f}% of regions.")
rows = []
for _, r in wb.iterrows():
    rows.append([TECH[r.tech], r.band, f"{r.regions:,}", f"{r.cf_mean:.3f}", f"{r.cf_2024:.3f}", sgn(r.dev_2024_pct, 1, "%"),
                 f"{sgn(r.min_pct, 1, '%')} to {sgn(r.max_pct, 1, '%')}", int(r.rank_2024)])
crow = []
for _, r in wc.iterrows():
    crow.append([r.city, TECH[r.tech], f"{r.cf_mean:.3f}", f"{r.cf_2024:.3f}", sgn(r.dev_2024_pct, 1, "%"),
                 f"{sgn(r.min_pct, 1, '%')} to {sgn(r.max_pct, 1, '%')}", int(r.rank_2024)])
section("1. Weather variability, 2015–2024",
        ["The atlas's hourly inputs for each year: NASA POWER solar (the shipped conversion) and ERA5 wind shaped to the "
         "Global Wind Atlas level with each site's 2024 multiplier held fixed, so year-to-year differences are weather only. "
         "Band values are people-weighted means over the deployed regions (unweighted where a band has no people); "
         "‘rank’ orders the ten band-years from best (1) to worst (10).",
         "These are weather effects only: the sites, the GWA level and the 2024 multiplier are today's. T061 (wind site selection and level "
         "factors) is a separate change. The per-region ratio of ten-year mean to 2024 (results/cf_ratio_by_region.csv) is a weather factor "
         "that does not depend on T061's level factors, but it does depend on where the sites are."] + paras,
        [(["Technology", "Latitude band", "Regions", "CF 2015–2024", "CF 2024", "2024 vs mean", "Range of years vs mean",
           "2024 rank"], rows, ""),
         (["City", "Technology", "CF 2015–2024", "CF 2024", "2024 vs mean", "Range of years vs mean", "2024 rank"], crow,
          "Cities: the region whose site is nearest, as in scratchpad/curves/curves.py. Offshore only where the region has a sea site.")])

# ---------------------------------------------------------------- 2 headlines
rows = []
for T in (80, 90, 99):
    for W in ("people", "demand"):
        for key, lab, f in (("hw.lower", "Wind is the cheaper route (hw.lower)", "pct1"),
                            ("hw.lower15", "…by more than $15/MWh (hw.lower15)", "pct1"),
                            ("hw.medSaving", "Median saving where cheaper", "usd")):
            k = f"{key}.{W}.{T}"
            a, b = v24.get(k), v10.get(k)
            d = sgn(dpts(a, b), 1, " pts") if f == "pct1" else dusd(a, b)
            rows.append([f"{T}%", W, lab, F(a, f), F(b, f), d])
        if T < 99:
            k = f"t1.cut.{W}.{T}"
            a, b = v24.get(k), v10.get(k)
        else:
            a, b = cut99(t1_24, W), cut99(t1_10, W)
        rows.append([f"{T}%", W, "Like-for-like cost cut" + (" (t1.cut)" if T < 99 else " (analyse.py)"),
                     F(a, "pct1"), F(b, "pct1"), sgn(dpts(a, b), 1, " pts")])
head_rows = rows
t4rows = []
for T in (80, 90, 99):
    n24, n10 = north(s24, T), north(s10, T)
    if T < 99:  # check: the report's aggregation equals the model's take-4 values
        for k in ("sbStd", "sbBoth", "windBoth", "lgWins"):
            mv = v24.get(f"t4.{k}.n50p.{T}")
            assert mv is None or abs(mv - n24[k]) < 1e-6, (k, T, mv, n24[k])
    for k, lab, f in (("sbStd", "Solar + battery reach, slider builds (people)", "pct1"),
                      ("sbReach", "Solar + battery reach incl. large builds (people)", "pct1"),
                      ("sbBoth", "Solar + battery cost, large builds included (median, both reach)", "usd"),
                      ("windBoth", "Cost with wind (median, both reach)", "usd"),
                      ("lgWins", "Regions where a large build is the no-wind answer", "int")):
        a, b = n24[k], n10[k]
        d = sgn(dpts(a, b), 1, " pts") if f == "pct1" else (sgn(b - a, 0) if f == "int" else dusd(a, b))
        t4rows.append([f"{T}%", lab, F(a, f), F(b, f), d])
chg_rows = []
for T in (80, 90, 99):
    k = lambda s, T: np.char.add(np.char.add(np.char.add(s[f"solar_gw_{T}"].astype(str), "|"), np.char.add(s[f"wind_gw_{T}"].astype(str), s[f"surface_{T}"])), np.char.add("|", s[f"batt_gwh_{T}"].astype(str)))
    m24_, m10_ = s24[f"meets_{T}"] > 0, s10[f"meets_{T}"] > 0
    both = m24_ & m10_
    chg = both & (k(s24, T) != k(s10, T))
    dl = (s10[f"lcoe_{T}"] - s24[f"lcoe_{T}"])[both]
    rel = (s10[f"lcoe_{T}"] / s24[f"lcoe_{T}"] - 1)[both] * 100
    pop = s24["pop"]
    chg_rows.append([f"{T}%", f"{int(chg.sum()):,} of {int(both.sum()):,}", f"{pop[chg].sum() / 1e9:.2f} bn",
                     f"{np.median(rel):+.1f}%".replace("-", "−"), f"{np.quantile(rel, 0.1):+.1f}% to {np.quantile(rel, 0.9):+.1f}%".replace("-", "−"),
                     f"{int((m24_ & ~m10_).sum())} / {int((~m24_ & m10_).sum())}"])
t5keys = ["t5.cutMin", "t5.cutMax", "t5.cheaperMin", "t5.windBoth.demand.2026", "t5.windBoth.demand.2050"]
bmap24 = {b["key"]: b for b in m24["bound"]}
bmap10 = {b["key"]: b for b in m10["bound"]}
t5rows = [[k, bmap24[k]["text"], bmap10[k]["text"]] for k in t5keys]
brows, seen, nchg = [], set(), 0
for b in m24["bound"]:
    if b["key"] in seen:
        continue
    seen.add(b["key"])
    n = bmap10[b["key"]]
    chg = b["text"] != n["text"]
    nchg += chg
    src = ("model" if b["fromModel"] else
           "derived from model" if b["key"] in ("t5.cutMin", "t5.cutMax", "t5.cheaperMin", "t2.mult", "t2.multLow", "t2.total.pwh") else
           "analysis (not weather-dependent)" if b["key"].startswith("t3.") else
           "recorded app draws (not recomputed)" if b["key"].startswith("loc.") else "external / parameter")
    brows.append([b["key"], b["text"], n["text"], "changes" if chg else "", src])
section("2. Headline numbers, 2024 against the ten-year average",
        ["All from the article model (scripts/article/tools/model.js, the app's own LCOE worker) run once on deployment/data "
         "and once on deployment/data_10y, global costs, base year 2026, add-on on. The 99% like-for-like cut comes from "
         "analyse.py (the model does not compute t1 at 99%), and take 4 at 99% from the engine's per-region results with "
         "the model's definitions (checked equal to the model's own take-4 values at 80% and 90%).",
         f"Of the {len(brows)} distinct numbers bound in the article, {nchg} would read differently on the ten-year data. "
         "‘model’ rows are recomputed; ‘analysis’ and ‘embedded’ rows come from committed analysis or external sources "
         "and are not recomputed here (the Local-cost numbers loc.* come from recorded app draws)."],
        [(["Target", "Weight", "Measure", "2024", "2015–2024", "Change"], head_rows, ""),
         (["Target", "Regions whose cheapest build changes", "People there", "Cost change, median", "10th–90th percentile",
           "Regions losing / gaining the target"], chg_rows,
          "Cheapest build with wind allowed (the LCOE map), regions meeting the target on both data sets."),
         (["Target", "North of 50°N (people-weighted)", "2024", "2015–2024", "Change"], t4rows,
          "Take 4 in the article binds the 90% values (t4.*.n50p.90)."),
         (["Take 5 value", "2024", "2015–2024"], t5rows, "Take 5 range: the like-for-like cut and the ‘cheaper’ share over 2026–2050."),
         (["Bound number", "Article now (2024)", "On ten-year data", "", "Source"], brows, "")])

# ---------------------------------------------------------------- 3 city curves (SVG)
T = c24["targets"]
names = list(c24["cities"].keys())


def panel(name, x0, y0, w, h, key, ymax):
    a, b = c24["cities"][name][key], c10["cities"][name][key]
    def xy(i, v):
        return x0 + (T[i] - 0.70) / 0.29 * w, y0 + h - min(v, ymax) / ymax * h
    def path(vals):
        segs, cur = [], []
        for i, v in enumerate(vals):
            if v is None:
                if cur:
                    segs.append(cur); cur = []
                continue
            cur.append(xy(i, v))
        if cur:
            segs.append(cur)
        return "".join(f"M{' L'.join(f'{x:.1f},{y:.1f}' for x, y in s)} " for s in segs)
    g = [f'<text x="{x0}" y="{y0 - 6}" class="pt">{html.escape(name)}</text>',
         f'<line x1="{x0}" y1="{y0 + h}" x2="{x0 + w}" y2="{y0 + h}" class="ax"/>']
    for yv in (0, ymax / 2, ymax):
        yy = y0 + h - yv / ymax * h
        g.append(f'<text x="{x0 - 4}" y="{yy + 3:.1f}" class="tk" text-anchor="end">${yv:.0f}</text>')
    for tv in (0.70, 0.80, 0.90, 0.99):
        xx = x0 + (tv - 0.70) / 0.29 * w
        g.append(f'<text x="{xx:.1f}" y="{y0 + h + 12}" class="tk" text-anchor="middle">{round(tv * 100)}%</text>')
    g.append(f'<path d="{path(a)}" class="l24"/><path d="{path(b)}" class="l10"/>')
    return "".join(g)


def chart(key, title, ymax):
    cols, pw, ph, gx, gy = 5, 150, 90, 58, 44
    W = cols * (pw + gx) + 10
    H = 3 * (ph + gy) + 40
    parts = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="{html.escape(title)}" class="chart">']
    for k, n in enumerate(names):
        r, c = divmod(k, cols)
        parts.append(panel(n, 48 + c * (pw + gx), 30 + r * (ph + gy), pw, ph, key, ymax))
    parts.append("</svg>")
    return (f"<figure><figcaption><b>{html.escape(title)}</b><br><span class=leg><i class=k24></i>2024 weather "
            f"<i class=k10></i>2015–2024 average</span></figcaption>{''.join(parts)}"
            f"<p class=note>Cheapest build meeting each uptime target (70–99%), global costs, base year 2026, add-on on. "
            f"Gaps: target not reachable. Values above ${ymax} are drawn at the top. Source: atlas model on deployment/data and data_10y.</p></figure>")


def curve_rows(key):
    rows = []
    for n in names:
        for t in (0.80, 0.90, 0.99):
            i = T.index(t)
            a, b = c24["cities"][n][key][i], c10["cities"][n][key][i]
            rows.append([n, f"{round(t * 100)}%", F(a, "usd"), F(b, "usd"),
                         dusd(a, b, 0)])
    return rows


svg1 = chart("w", "Ten-year weather changes city costs little where wind is in the mix", 250)
svg2 = chart("sb", "Solar + battery alone: the ten-year weather moves high-uptime costs most", 400)
section("3. City cost curves, 70–99% uptime",
        ["The 15 cities of scratchpad/curves/curves.py, from the article engine on each data folder. "
         "Charts are in the HTML page; the table gives 80%, 90% and 99%.",
         "At 99% the ten-year curve often sits below the 2024 one (London, Berlin, Delhi) although the weather is not better: a target met on "
         "the ten-year average lets a good year make up for a bad one. Among regions whose cheapest ten-year build is a slider build, "
         + "; ".join(f"at {T}% {wy[T]['share_some_year_below'] * 100:.0f}% fall short of the target in at least one year "
                     f"(median worst year {wy[T]['median_worst'] * 100:.1f}%, median {wy[T]['median_years_below']:.0f} years short)"
                     for T in ("80", "90", "99"))
         + ". The 2024 data meets the target in its one year. That is a change of reliability standard, not only of weather (open question 7)."],
        [(["City", "Target", "With wind, 2024", "With wind, 2015–2024", "Change"], curve_rows("w"), ""),
         (["City", "Target", "Solar + battery, 2024", "Solar + battery, 2015–2024", "Change"], curve_rows("sb"), "")],
        extra_html=svg1 + svg2)

# ---------------------------------------------------------------- 4 large builds
paras = ["The shipped large builds (solar 20–200 GW × battery 36–4,608 GWh) repeat 2024 until the battery's "
         "end-of-year charge equals its start (a cyclic year). The ten-year set runs the 87,672 hours once, from an "
         "empty battery on 1 January 2015, so a seasonal store has to fill itself and is tested on ten winters "
         "instead of one repeated one."]
rows = []
for T in (80, 90, 99):
    n24, n10 = north(s24, T), north(s10, T)
    rows.append([f"{T}%", F(n24["sbBoth"], "usd"), F(n10["sbBoth"], "usd"), dusd(n24["sbBoth"], n10["sbBoth"], 0),
                 F(n24["lgWins"], "int"), F(n10["lgWins"], "int"),
                 f"{F(n24['lgSolar'], 'int')} / {F(n24['lgBatt'], 'int')}", f"{F(n10['lgSolar'], 'int')} / {F(n10['lgBatt'], 'int')}"])
if lsens:
    paras.append(lsens["text"])
section("4. The large builds without the repeating year",
        paras,
        [(["Target", "N of 50°N solar + battery cost, 2024 (cyclic)", "Ten-year (cold start)", "Change",
           "Large build wins, 2024", "Ten-year", "Median solar GW / battery GWh, 2024", "Ten-year"], rows,
          "People-weighted medians over regions north of 50°N where both the cheapest build with wind and the best "
          "solar + battery build reach the target.")])

SECTIONS_EXTRA = {}
OUT_MD = repo / "team/reports/T060-ten-year.md"
OUT_HTML = repo / "team/reports/T060-before-after.html"
TAIL = json.loads((RES / "report_tail.json").read_text())   # sections 5 and 6, written by hand after the run

for t, ps, tabs in TAIL["sections"]:
    section(t, ps, [(h, r, n) for h, r, n in tabs])


def write():
    md = [f"# {TAIL['title']}", "", TAIL["lead"], ""]
    for title, ps, tabs, xh, xm in SECTIONS:
        md += [f"## {title}", ""]
        for p in ps:
            md += [p, ""]
        for h, r, n in tabs:
            md += [md_table(h, r), ""]
            if n:
                md += [f"*{n}*", ""]
    OUT_MD.write_text("\n".join(md))
    css = (":root{--bg:#fff;--fg:#1a1a1a;--muted:#5b6470;--line:#e3e6ea;--acc:#0b7a75;--c24:#9aa3ad;--c10:#0b7a75}"
           "@media (prefers-color-scheme:dark){:root:not([data-theme=\"light\"]){--bg:#111416;--fg:#e8eaed;--muted:#9aa3ad;--line:#2a2f35;--acc:#4fd1c5;--c24:#6b7480;--c10:#4fd1c5}}"
           ":root[data-theme=\"dark\"]{--bg:#111416;--fg:#e8eaed;--muted:#9aa3ad;--line:#2a2f35;--acc:#4fd1c5;--c24:#6b7480;--c10:#4fd1c5}"
           "body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px}"
           "main{max-width:1080px;margin:0 auto} h1{font-size:24px;margin:0 0 4px} h2{font-size:17px;margin:28px 0 8px;color:var(--acc)}"
           "p.lead{color:var(--muted);margin:0 0 16px} table{border-collapse:collapse;width:100%;font-size:14px}"
           "th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top} td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}"
           ".wrap{overflow-x:auto} .note{color:var(--muted);font-size:13px} figure{margin:16px 0} svg.chart{width:100%;height:auto}"
           ".pt{font-size:12px;fill:var(--fg);font-weight:600} .tk{font-size:9px;fill:var(--muted)} .ax{stroke:var(--line)}"
           ".l24{fill:none;stroke:var(--c24);stroke-width:1.6} .l10{fill:none;stroke:var(--c10);stroke-width:1.8}"
           ".leg{font-size:13px;color:var(--muted)} .leg i{display:inline-block;width:18px;height:3px;margin:0 6px 3px 10px;vertical-align:middle}"
           ".k24{background:var(--c24)} .k10{background:var(--c10)}")
    h = [f"<!doctype html><html lang=\"en-GB\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
         f"<title>Ten-year weather</title><style>{css}</style></head><body><main>",
         f"<h1>{html.escape(TAIL['title'])}</h1><p class=lead>{html.escape(TAIL['lead'])}</p>"]
    for title, ps, tabs, xh, xm in SECTIONS:
        h.append(f"<h2>{html.escape(title)}</h2>")
        for p in ps:
            h.append(f"<p>{html.escape(p)}</p>")
        h.append(xh)
        for hd, r, n in tabs:
            h.append(html_table(hd, r, num_from=2 if hd[0] in ("Technology", "City", "Target") else 1))
            if n:
                h.append(f"<p class=note>{html.escape(n)}</p>")
    h.append("</main></body></html>")
    OUT_HTML.write_text("".join(h))
    for p in (OUT_MD, OUT_HTML):
        t = p.read_text()
        assert "—" not in t, f"em dash in {p}"
    print("wrote", OUT_MD, OUT_HTML)


write()
