#!/usr/bin/env python3
"""charts-build.py – builds deployment/scrollytelling/charts.html, the charts-only version of the article (T091).

The same approved text as index.html (team/reports/T087-article-v2.md, word for word, every number bound), but no
scrollytelling: no maps, no pinned stage, no cards, no morphs and no scroll-driven chart motion. Each section carries
one or two conventional charts in the Ember frame (accent bar, full-sentence title, subtitle with the unit, key,
source), drawn statically by js/charts-page.js from the summary.

The text, the shared figures, the notes and the sources come from story-build.py (imported, so a paragraph that no
longer reads as the draft stops this build too). Only the choice and order of the charts are made here (LAYOUT).

usage (repo root): python3 scripts/article/tools/charts-build.py [--check]
"""
import importlib.util
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('story_build', HERE / 'story-build.py')
SB = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(SB)

ROOT, SITE = SB.ROOT, SB.SITE
OUT = SITE / 'scrollytelling/charts.html'
ATLAS = SB.ATLAS


def static(fig):
    """A figure without scroll motion: data-motion, data-reveal, data-steps and data-pin dropped."""
    return re.sub(r'\s+data-(?:motion|reveal|steps|pin)="[^"]*"', '', fig)


def fig(fid, chart, title, sub, source):
    return static(SB.new_fig(fid, chart, title, sub, source))


# ---- the charts --------------------------------------------------------------------------------------------------
# Kept from the article (the same chart, data and wording, drawn without motion)
DROUGHT, BACKUP = (static(f) for f in (SB.FIG_DROUGHT, SB.FIG_BACKUP))   # shift and weights dropped (the human, 6 Nov 2026)
MONTHLY = static(SB.index_fig('chart-3'))      # solar and wind by month, nine European countries

# New (T091): conventional charts in place of the map segments, each from summary values already in the summary
BANDS90 = fig('chart-bands90', 'bands90',
              'Without wind, the cost of firm power climbs with latitude; with wind, it stays under $100/MWh',
              'Median cost of 90% uptime ($/MWh), by latitude band',
              f'Source: {ATLAS} (2026 local costs); Chen et al. (2022); Ember analysis')
TIERS = fig('chart-tiers', 'tiers',
            'Solar, wind and batteries offer a cheap alternative to most planned coal and gas',
            'Planned coal and gas capacity, and the part in regions where the cheapest build reaches 80% uptime under $100/MWh without wind, under $100/MWh with wind and under $130/MWh with wind (GW), 2026 local costs',
            f'Source: Global Energy Monitor (2024); {ATLAS} (2026 local costs); Ember analysis')
# Section 1 (the human, T091 round 6: "a chart that shows how much adding wind to solar + battery saves by different
# latitudes and different % uptimes, up to 99%"): the demand-weighted median saving by band of latitude, 50-99% uptime
# (summary lb.saving.<band>.<T>.2026, model.js bandValues: where both builds reach the target)
LATSAVE = static(SB.FIG_LATSAVE)   # the round-8 figures are defined in story-build.py, shared with the scrolly

# Section 6 (the human, T091 round 6: in place of TIERS, "a version of the histogram chart from the tool"): planned coal
# and gas by the cost of power every hour where it is planned, from solar, wind and batteries for 90% (or 95%) uptime and
# backup for the rest (charts-page.js drawPlannedHist; story-cells c100, story-backup95.json, story-planned.json). The
# human: call it backup, and say in a footnote that it assumes diesel or gas (the atlas's backup: diesel or gas, local prices).
def hist_fig(fid, chart, title, uptime, source_mode):
    f = fig(fid, chart, title,
            f'Share of all planned coal and gas capacity by the cost of power every hour where it is planned, from the cheapest solar, wind and battery build for {uptime} uptime with backup for the rest ($/MWh), 2026 local costs',
            f'Source: Global Energy Monitor (2024); {ATLAS} ({source_mode}); IGU (2024); Ember analysis')
    return f.replace('<p class="chart-source">', '<p class="chart-note">Note: backup assumes diesel or gas generators.</p> <p class="chart-source">', 1)


PLANHIST = static(SB.FIG_PLANHIST)
PLANHIST95 = hist_fig('chart-planhist95', 'planhist95',
                      'From 95% uptime too, solar, wind and batteries with backup could stand in for most planned coal and gas for under $100/MWh',
                      '95%', '2026 local costs, backup mode')
# Section 5 (the human, 6 Nov 2026: in place of the population cartogram and the land/people/demand chart): "a histogram,
# much like we have it in the tool, cost on the horizontal axis, share of population on the vertical axis ... 90% uptime plus
# backup", and "a chart with the latitudes on the y-axis: where people live, how cheap solar plus battery is, and solar,
# battery plus wind" (charts-page.js drawPeopleCharts; story-cells pop, c100, c90sb, c90; summary cell latitudes)
PEOPLEHIST = static(SB.FIG_PEOPLEHIST)
LATPEOPLE = static(SB.FIG_LATPEOPLE)

# Section 7 (the human, T091 round 4: a GW threshold depends on how big the atlas draws a region; a multiple of demand,
# counted by country, does not): countries whose wind could meet their national demand at least 1, 2, 5 and 10 times
COUNTRIES = static(SB.FIG_COUNTRIES)
BANDSAVE = fig('chart-bandsave', 'bandsave',
               'The saving from wind shrinks by 2050 but stays large in the north',
               'Median saving from adding wind to firm power ($/MWh), by latitude band',
               f'Source: {ATLAS} (local cost paths, backup mode); Chen et al. (2022); IGU (2024); Ember analysis')
BANDSAVE = BANDSAVE.replace('<p class="chart-source">', '<p class="chart-note">Firm power: 90% uptime from solar, wind and batteries, diesel or gas backup for the rest. Backup equipment and fuel at today\'s prices.</p> <p class="chart-source">', 1)
# Section 4 (T100, the human, 9 Nov 2026: in place of the uptime steps chart, "balancing costs"): what the backup costs when a
# 90% build is taken to every hour, without and with wind (article-charts.js; s4bk.* from derive_t100.py)
# Section 4 (T100, the human, 9 Nov 2026: "a line chart ... from 60% to 100% uptime, where the rest is backup"), in place of the
# cost split: the build's uptime ends at 99% (the model does not reach 100% without backup)
BKCURVE = fig('chart-bkcurve', 'bkcurve',
              'With wind, renewables reach higher uptime for the same cost, requiring less backup',
              'Average cost of firm solar and wind power ($/MWh), by the uptime of the renewable build',
              f'Source: {ATLAS} (2026 local costs, backup mode); Chen et al. (2022); IGU (2024); Ember analysis')
BKCURVE = BKCURVE.replace('<p class="chart-source">', '<p class="chart-note">Gas or diesel backup covers the rest. Averages weighted by electricity demand.</p> <p class="chart-source">', 1)
BACKUPBANDS = fig('chart-backupbands', 'backupbands',
                  'Adding wind cuts the cost of power every hour of the year, most of all further from the equator',
                  'Average cost of power every hour ($/MWh), world and by latitude band',
                  f'Source: {ATLAS} (2026 local costs, backup mode); Chen et al. (2022); IGU (2024); Ember analysis')
BACKUPBANDS = BACKUPBANDS.replace('<p class="chart-source">', '<p class="chart-note">Every hour: 90% uptime from solar, wind and batteries, diesel or gas backup for the rest. Averages weighted by electricity demand.</p> <p class="chart-source">', 1)

# Maps (T091 round 2, the human: "I want maps"): each scrolly map segment as one static map figure, drawn by
# js/static-map.js with the scrolly map's own colours, legends and tooltips (story-layers.js). A note under a map
# carries what a card said beside it, its numbers bound like the text's.
def map_fig(fid, title, sub, source, note=None):
    f = fig(fid, fid, title, sub, source)
    if note:
        f = f.replace('<p class="chart-source">', f'<p class="chart-note">{SB.bind(note)}</p> <p class="chart-source">', 1)
    return f.replace('<figure class="chart"', '<figure class="chart chart--map"', 1)


M_COST90 = map_fig('map-cost90',
                   SB.SEG_TITLES['take-1'],
                   'Cost of 90% uptime ($/MWh): solar and batteries alone (top), with wind (bottom)',
                   f'Source: {ATLAS} (2026 local costs); Ember analysis')
# T091 (the human, 5 Nov 2026): the cost-of-capital lens, shown once in section 1 before the article holds it at one rate
M_WACC = map_fig('map-wacc',
                 'With each region\'s own cost of capital, power is dearest where finance is',
                 'Cost of capital (% a year; top), and the cost of 90% uptime with it ($/MWh; bottom)',
                 f'Source: Hatton et al. (2025); {ATLAS} (2026 costs, with each region\'s own cost of capital); Ember analysis')
M_SAVING = map_fig('map-saving',
                   SB.SEG_TITLES['take-2'],
                   'Saving from adding wind at 90% uptime ($/MWh); regions north of 45°N lie above the dashed line',
                   f'Source: {ATLAS} (2026 local costs); Ember analysis')
M_DROUGHT = map_fig('map-drought',
                    SB.SEG_TITLES['take-3'],
                    'Share of weeks in a lull (%), 2015–2024',
                    f'Source: {ATLAS} (hourly solar and onshore wind profiles, 2015–2024); Ember analysis')
M_BACKUP = map_fig('map-backup',
                   SB.SEG_TITLES['take-4'],
                   'Cost ($/MWh): 99% uptime from solar, wind and batteries (top); firm power with gas or diesel backup (bottom)',
                   f'Source: {ATLAS} (2026 local costs, backup mode); IGU (2024); Ember analysis')
M_PLANNED = map_fig('map-planned',
                    SB.SEG_TITLES['take-6'],
                    'Planned coal and gas, by its cheapest alternative at 80% uptime; circle size: capacity',
                    f'Source: Global Energy Monitor (2024); {ATLAS} (2026 local costs); Ember analysis')
M_POTENTIAL = map_fig('map-potential',
                      SB.SEG_TITLES['take-7'],
                      'Wind potential as a multiple of local electricity demand, conservative case',
                      f'Source: {ATLAS}; World Bank/ESMAP (2021); Chen et al. (2022); Ember analysis')
M_SAVING99 = map_fig('map-saving99',
                     SB.SEG_TITLES['take-8'],
                     'Saving from adding wind to firm power ($/MWh), in 2026 (top) and in 2050 (bottom)',
                     f'Source: {ATLAS} (local cost paths, backup mode); IGU (2024); Ember analysis',
                     'Firm power: 90% uptime from solar, wind and batteries, diesel or gas backup for the rest. Backup equipment and fuel at today\'s prices.')
BANDSAVE = BANDSAVE.replace('The saving from wind shrinks by 2050 but stays large in the north', 'The further from the equator, the more of wind\'s saving lasts to 2050')

# Each section: its paragraphs (by their order in story-build.py's section) and charts, in reading order.
# Each map segment of the scrolly becomes a map figure (M_*), next to the chart its morph landed on. Left out on purpose:
# chart-1 (saving by uptime) and chart-4 (cost by latitude with a city per band) repeat bands90; chart-5 (animated
# curves) needs motion; chart-5b (90% to 2050) and n45 give way to map-saving99 and bandsave (99%, as the text);
# planned (ten countries at 90%) and t2 (potential against demand) give way to the maps, keeping two figures a section
# where the scrolly had one segment (their numbers stay in the text).
BOX_OPEN = ('<details class="fold-box" id="finance-box" open><summary><span class="fold-box__label">Box</span> '
            + SB.BOX_TITLE.replace('Box: ', '') + '</summary><div class="fold-box__body">')   # T100: the finance box folds (the human)
BOX_CLOSE = '</div></details>'   # the finance box's heading (T100: the human's draft)
# T100 round 7 (the human's draft of 9 Nov 2026, team/reports/T100/source-9nov): the 17 charts in the draft's order and
# places (image -> chart in team/handoffs/T100.md); bands90 and the uptime ladder are not in the draft, so not on the page
LAYOUT = {
    'two-harvests': [0, 1, 2, 3, 4, 5],   # the human's restructure of 'From cheap to firm' (9 Nov 2026); no chart (t3 moved to section 2)
    'take-1': [0, 1, 2, 3, M_COST90, BOX_OPEN, 4, 5, M_WACC, BOX_CLOSE],
    'take-2': [0, LATPEOPLE, 1, M_SAVING, 2, MONTHLY, 3, 4, 5, PEOPLEHIST],   # the human's section 2 (bands90 and latsave off the page, code kept)
    'take-3': [0, 1, M_DROUGHT, 2, DROUGHT, 3, 4],
    'take-4': [0, 1, 2, M_BACKUP, 3, BKCURVE, 4],   # the human: the backup curve in place of the cost split (code kept)
    'take-5': [0, M_PLANNED, 1, PLANHIST, 2, 3],
    'take-6': [0, M_POTENTIAL, 1, 2],   # the human: multcountries off the page (code kept)
    'take-7': [0, M_SAVING99, 1, BANDSAVE],
    'conclusion': [0, 1, 2, 3],   # the human's rewrite of the close
}


def render_sections():
    out = []
    seen = set()
    for sid, num, head, blocks in SB.SECTIONS:
        paras = [body for kind, body in blocks if kind == 'p']
        parts = [f'<section class="take take--linear" id="{sid}">']
        if num:
            parts.append(f'<div class="take-number">{num}</div>')
        parts.append(f'<h2>{head}</h2>')
        for b in LAYOUT[sid]:
            if isinstance(b, int):
                parts.append(SB.P(paras[b]))
                seen.add((sid, b))
            else:
                parts.append(b)
        missing = [k for k in range(len(paras)) if (sid, k) not in seen]
        if missing:
            raise SystemExit(f'charts-build: section {sid} leaves out paragraph(s) {missing} of the approved text')
        out.append('\n            '.join(parts) + '\n        </section>')
    if set(LAYOUT) != {s[0] for s in SB.SECTIONS}:
        raise SystemExit(f'charts-build: LAYOUT and story-build.py\'s sections differ: {sorted(set(LAYOUT) ^ {s[0] for s in SB.SECTIONS})}')
    return '\n\n        '.join(out)


body = render_sections()
if SB.mismatch:
    raise SystemExit('charts-build: text differs from the draft\n  ' + '\n  '.join(SB.mismatch))
charts = re.findall(r'data-chart="([^"]+)"', body)
if len(charts) != len(set(charts)):
    raise SystemExit(f'charts-build: a chart is placed twice: {charts}')

notes = SB.notes   # the short notes (9 Nov 2026) name no page element, so both versions share them as they are
ABOUT = SB.ABOUT.replace('The interactive maps, charts and page code were', 'The charts and page code were')
if ABOUT == SB.ABOUT:
    raise SystemExit('charts-build: the about text changed; update the swap here')

html = f'''<!DOCTYPE html>
<html lang="en-GB">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{SB.title_md} | Solar + Wind + Battery Atlas</title>
    <!-- T091: the charts-only version of the article, built by scripts/article/tools/charts-build.py from the approved
         text (team/reports/T087-article-v2.md, word for word, every number a bound span, checked by verify-article).
         Static maps and charts, no scroll-driven motion. Edit the builder, not this file. -->
    <meta name="description" content="{SB.H.escape(SB.meta)} An Ember analysis.">

    <!-- Everything is served from this site: no fonts, scripts or styles from another host. -->
    <link rel="preload" href="fonts/poppins-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="fonts/poppins-latin-600-normal.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="modulepreload" href="js/charts-page.js">
    <link rel="modulepreload" href="js/story-charts.js">
    <link rel="modulepreload" href="js/charts.js">
    <link rel="modulepreload" href="js/static-map.js">
    <link rel="modulepreload" href="js/story-layers.js">
    <link rel="modulepreload" href="js/layers.js">
    <link rel="modulepreload" href="../js/constants.js">
    <link rel="modulepreload" href="js/summary.js">
    <link rel="modulepreload" href="js/format.js">
    <link rel="preload" href="data/article-summary.json" as="fetch" crossorigin>
    <link rel="preload" href="data/story-cells.json" as="fetch" crossorigin>
    <link rel="preload" href="data/story-localwacc.json" as="fetch" crossorigin>
    <link rel="preload" href="data/story-planned.json" as="fetch" crossorigin>
    <link rel="preload" href="../data/world.geojson" as="fetch" crossorigin>
    <meta name="color-scheme" content="light">
    <link rel="stylesheet" href="css/story.css">
    <link rel="stylesheet" href="css/charts-page.css">
</head>

<body class="story story--charts">
    <article class="article" id="article">

        <header class="opening opening--plain" id="top">
            <div class="opening__inner">
                <h1>{SB.title_md}</h1>
                <div class="tbar" aria-hidden="true"></div>
                <p class="standfirst">{SB.bind(SB.standfirst_md)}</p>
                <p class="byline">{SB.byline_md}</p>
            </div>
        </header>

        {SB.FINDINGS_HTML}

        {body}

        {notes}

        {SB.sources}

        {ABOUT}
    </article>

    <script src="vendor/d3.v7.9.0.min.js"></script>
    <script type="module" src="js/charts-page.js"></script>
    <script>
        // T100: the finance box is open while the page draws (the map takes its width from it), then folds
        (function () {{
            var box = document.getElementById('finance-box'), t0 = Date.now();
            (function wait() {{
                var map = document.querySelector('#map-wacc canvas, #map-wacc svg');
                if (box && (map || Date.now() - t0 > 15000)) {{ box.open = false; return; }}
                setTimeout(wait, 200);
            }})();
        }})();
    </script>
</body>

</html>
'''
if re.search(r'\bclean', html.replace(SB.CLEAN_OK, ''), re.I):   # T100: the human's own phrase only
    raise SystemExit('charts-build: the word "clean" is in charts.html')
if '—' in SB.reads(body):
    raise SystemExit('charts-build: an em dash in the prose')

if '--check' in sys.argv:
    if not OUT.exists() or OUT.read_text() != html:
        raise SystemExit('scrollytelling/charts.html differs from what charts-build.py gives (run it to rebuild)')
    print(f'charts.html is what charts-build.py gives: the approved text word for word, {len(charts)} charts ({", ".join(charts)})')
    raise SystemExit(0)
OUT.write_text(html)
print(f'wrote {OUT.relative_to(ROOT)}: {len(html):,} bytes; {len(charts)} charts: {", ".join(charts)}')
