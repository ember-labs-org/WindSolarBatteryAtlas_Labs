#!/usr/bin/env python3
"""story-build.py – builds deployment/scrollytelling/index.html, the article, from the approved text (T087).
The previous article is kept as scrollytelling/classic.html; its notes, sources and figures are lifted from there.

The text is team/reports/T087-article-v2.md, word for word. Each paragraph below is that text with its numbers
written as [[key|format]]: the build swaps in a bound span (<span data-n data-f>) whose static text is the committed
summary's value, and then checks that the paragraph, as it reads, equals the draft's paragraph exactly. A number
the data no longer gives (or a changed word) stops the build, listing the paragraph.

A section is (id, number, heading, blocks): blocks are paragraphs ('p'), a map segment ('seg': its cards are
sentences moved out of the section's text, each with a map state and view) or a figure ('fig'). Reorder sections or
blocks freely; see the guide in team/handoffs/T087.md.

usage (repo root): python3 scripts/article/tools/story-build.py
"""
import html as H
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SITE = ROOT / 'deployment'
DRAFT = (ROOT / 'team/reports/T087-article-v2.md').read_text()
INDEX = (SITE / 'scrollytelling/classic.html').read_text()   # the previous article: notes, sources, figures
VALUES = json.loads((SITE / 'scrollytelling/data/article-summary.json').read_text())['values']
OUT = SITE / 'scrollytelling/index.html'


# ---- number formats (as js/format.js) -------------------------------------------------------------------------
def rnd(x):
    return math.floor(x + 0.5)


def nf(x):
    return f'{rnd(x):,}'


FMT = {
    'pct': lambda v: f'{rnd(v * 100)}%',
    'pctnum': lambda v: f'{rnd(v * 100)}',
    'usd': lambda v: f'${nf(v)}',
    'int': lambda v: nf(v),
    'floor': lambda v: f'{math.floor(v):,}',
    'x2': lambda v: f'{v:.2f}×',
    'pct1': lambda v: f'{rnd(v * 1000) / 10:.1f}%',
    'pts': lambda v: f'{v * 100:.2f}',
    'r10': lambda v: f'{rnd(v / 10) * 10:,}',
    'r50': lambda v: f'{rnd(v / 50) * 50:,}',
    'h05': lambda v: f'{rnd(v * 2) / 2:.1f}',
    'd1': lambda v: f'{rnd(v * 10) / 10:.1f}',
}


def span(key, f, count=False):
    if key not in VALUES:
        raise SystemExit(f'no summary value for {key}')
    return f'<span{" data-count" if count else ""} data-n="{key}" data-f="{f}">{FMT[f](VALUES[key])}</span>'


def bind(t):
    return re.sub(r'\[\[([^|\]]+)\|([a-z0-9]+)\]\]', lambda m: span(m.group(1), m.group(2)), t)


def reads(html_text):
    """The text a paragraph reads as (tags dropped, entities decoded, whitespace collapsed)."""
    return re.sub(r'\s+', ' ', H.unescape(re.sub(r'<[^>]+>', '', html_text))).strip()


# ---- the draft, paragraph by paragraph ------------------------------------------------------------------------
def md_plain(s):
    return re.sub(r'\s+', ' ', s.replace('**', '').replace('*', '')).strip()


DRAFT_PARAS = [md_plain(p) for p in re.split(r'\n\s*\n', DRAFT.split('### Notes for review')[0])
               if p.strip() and not p.lstrip().startswith(('#', '---', '*['))]
used = set()
mismatch = []


def P(t, cls=None):
    """A paragraph of the draft, numbers bound; its reading must be one of the draft's paragraphs."""
    out = bind(t)
    r = reads(out)
    if r not in DRAFT_PARAS:
        mismatch.append(r)
    used.add(r)
    return f'<p{f" class=\"{cls}\"" if cls else ""}>{out}</p>'


def sentences_of(t):
    return re.split(r'(?<=[.)])\s+(?=[A-Z<\[])', t)


# ---- map segments: authored cards (the lead's brief, T087) ------------------------------------------------------
# Every section has one short segment: a pinned visual (the map, or a chart panel) and 2-4 steps: cards that read on
# their own (what is coloured or drawn, what it means, what is assumed; one idea each; at most 35 words; bound numbers
# only), a picture-only beat, and a last card with the takeaway. The cards are new text, listed for review in
# team/reports/T087-cards.md (written by this script).
CARD_WORDS = 35
cards_md = []


def card(text, state=None, view='world', chart=None, cs=0, dots=None, scrub=False):
    """A step: text (None = picture-only); a map state and view, or a chart panel and its reveal step, or a morph layout
    (dots) of its segment's dot set; scrub: the cost year follows the scroll on this card."""
    if text is not None:
        n = len(reads(bind(text)).split())
        if n > CARD_WORDS:
            mismatch.append(f'card over {CARD_WORDS} words ({n}): {reads(bind(text))}')
    return {'text': text, 'state': state, 'view': view, 'chart': chart, 'cs': cs, 'dots': dots, 'scrub': scrub}


# ---- figures -------------------------------------------------------------------------------------------------
def costs_wording(h):
    """T091 (the human, 5 Nov 2026): the article runs on local capital costs with one cost of capital everywhere (model.js
    COST_MODE: Capex Local + WACC Global), not on 'local costs' (the atlas's Local setting for both)."""
    h = h.replace('2026 local costs', bind('2026 costs, [[p.wacc|pct]] cost of capital'))
    h = h.replace("cost of capital held at today's", bind('cost of capital held at [[p.wacc|pct]]'))
    h = h.replace('(local costs)', '(local capital costs)').replace(', local costs, 2026', ', local capital costs, 2026')
    return h


def index_fig(fid, motion=''):
    f = re.search(r'(<figure class="chart" id="%s">.*?</figure>)' % fid, INDEX, re.S).group(1)
    f = re.sub(r'\s+', ' ', f).replace(' clean power', ' power')
    if motion:
        f = f.replace(f'<figure class="chart" id="{fid}">', f'<figure class="chart" id="{fid}" {motion}>')
    # T091 round 9 (the human: least text): the subtitle gives the measure and its unit only
    f = f.replace("Share of each source's annual output generated in each month, national fleets, 2023–2025 average (%), north to south",
                  "Share of each source's yearly output by month (%), 2023–2025")
    return costs_wording(f)


def new_fig(fid, chart, title, sub, source, motion='data-motion="rows"'):
    return costs_wording(f'<figure class="chart" id="{fid}" {motion}> <h3 class="chart-title">{title}</h3> '
                         f'<p class="chart-sub">{sub}</p> <div class="chart-svg" data-chart="{chart}"></div> '
                         f'<p class="chart-source">{source}</p> </figure>')


ATLAS = 'Ember, Solar + Wind + Battery Atlas'
FIG_SHIFT = new_fig('chart-shift', 'shift',
                    'With wind, more of the world\'s demand gets 90% uptime for under $100/MWh',
                    'Share of electricity demand and of people where the cheapest build reaches 90% uptime at or under $60, $80 and $100/MWh, without and with wind, 2026 local costs',
                    f'Source: {ATLAS} (2026 local costs); Chen et al. (2022); GPW v4; Ember analysis')
FIG_DROUGHT = new_fig('chart-drought', 'drought',
                      'Week-long solar and wind lulls rarely come at once',
                      'Share of weeks in a lull (%), 2015–2024',
                      f'Source: {ATLAS} (hourly solar and onshore wind profiles, 2015–2024); Ember analysis', motion='data-reveal="series"')
FIG_BACKUP = new_fig('chart-backup', 'backup',
                     'With wind, every step towards round-the-clock power costs less',
                     'Median cost per MWh of the full load ($/MWh)',
                     f'Source: {ATLAS} (2026 local costs, backup mode); IGU (2024); Ember analysis', motion='data-reveal="groups"')
# The round-8 charts (T091, D-170), the same on both versions of the article: drawn by js/article-charts.js; charts-build.py
# takes them from here without their motion. Each replaces a chart of the earlier rounds.
def with_note(f, note='Backup: diesel or gas generators.'):
    return f.replace('<p class="chart-source">', f'<p class="chart-note">{note}</p> <p class="chart-source">', 1)


# Section 1 (the human, T091 round 6): the saving from wind by band of latitude and uptime, 50-99% (in place of chart-1)
FIG_LATSAVE = new_fig('chart-latsave', 'latsave',
                      'The further from the equator and the higher the uptime, the more wind saves',
                      'Median saving from adding wind ($/MWh), by latitude band',
                      f'Source: {ATLAS} (2026 local costs); Chen et al. (2022); Ember analysis', motion='data-motion="grow"')
# Section 5 (the human, 6 Nov 2026: in place of the population cartogram and the land/people/demand chart)
FIG_PEOPLEHIST = with_note(new_fig('chart-pophist', 'pophist',
                                   'Most of the world\'s people live where firm solar and wind power costs under $100/MWh',
                                   'Share of world population (%)',
                                   f'Source: {ATLAS} (2026 local costs, backup mode); GPW v4; IGU (2024); Ember analysis', motion='data-motion="grow"'))
FIG_LATPEOPLE = new_fig('chart-latpeople', 'latpeople',
                        'Without wind, the cost of firm power climbs with latitude; with wind, it stays around $100/MWh',
                        'By latitude; costs are medians weighted by electricity demand',
                        f'Source: {ATLAS} (2026 local costs); Chen et al. (2022); Ember analysis', motion='data-motion="grow"')   # T100: by demand (the human)
# Section 6 (the human, T091 round 6: "a version of the histogram chart from the tool"; in place of the ten countries)
FIG_PLANHIST = with_note(new_fig('chart-planhist', 'planhist',
                                 'Solar, wind and batteries with backup could stand in for most planned coal and gas',
                                 'Share of planned coal and gas capacity (%)',
                                 f'Source: Global Energy Monitor (2024); {ATLAS} (2026 local costs, backup mode); IGU (2024); Ember analysis', motion='data-motion="grow"'))
# Section 7 (the human, T091 round 4: a multiple of demand, counted by country; in place of chart-2)
FIG_COUNTRIES = new_fig('chart-multcountries', 'multcountries',
                        'Most countries have far more wind than their own electricity demand',
                        bind('Number of countries, of [[s7.countries|int]], by how many times over their wind could cover their electricity demand'),
                        f'Source: {ATLAS}; World Bank/ESMAP (2021); Chen et al. (2022); Ember analysis')

# T101: the scrolly carries the charts article's figures (titles, subtitles and notes as in charts-build.py)
FIG_BKCURVE = with_note(new_fig('chart-bkcurve', 'bkcurve',
                                'With wind, renewables reach higher uptime for the same cost, requiring less backup',
                                'Average cost of firm solar and wind power ($/MWh), by the uptime of the renewable build',
                                f'Source: {ATLAS} (2026 local costs, backup mode); Chen et al. (2022); IGU (2024); Ember analysis', motion=''),
                        'Gas or diesel backup covers the rest. Averages weighted by electricity demand.')
FIG_BANDSAVE = with_note(new_fig('chart-bandsave', 'bandsave',
                                 'The further from the equator, the more of wind\'s saving lasts to 2050',
                                 'Median saving from adding wind to firm power ($/MWh), by latitude band',
                                 f'Source: {ATLAS} (local cost paths, backup mode); Chen et al. (2022); IGU (2024); Ember analysis', motion=''),
                         'Firm power: 90% uptime from solar, wind and batteries, diesel or gas backup for the rest. Backup equipment and fuel at today\'s prices.')
# the finance box's map, drawn by static-map.js as on charts.html (story.js)
FIG_WACC = costs_wording('<figure class="chart chart--map" id="map-wacc"> <h3 class="chart-title">With each region\'s own cost of capital, power is dearest where finance is</h3> '
                         '<p class="chart-sub">Cost of capital (% a year; top), and the cost of 90% uptime with it ($/MWh; bottom)</p> '
                         '<div class="chart-svg" data-chart="map-wacc"></div> '
                         f'<p class="chart-source">Source: Hatton et al. (2025); {ATLAS} (2026 costs, with each region\'s own cost of capital); Ember analysis</p> </figure>')

# ---- the article ----------------------------------------------------------------------------------------------
# T101 (audit A): each map segment's heading is the charts article's map title (charts-build.py takes its map titles from here)
SEG_TITLES = {
    'take-1': 'Adding wind cuts the cost of 90% uptime most beyond 45° north and south',
    'take-2': 'The saving from wind is largest further from the equator',
    'take-3': 'Weeks with a solar and a wind lull at once are rare everywhere',
    'take-4': 'Covering the last hours with a little gas or diesel backup costs less than building batteries for 99% uptime',
    'take-6': 'Most planned coal and gas is in places where solar, wind and batteries cost under $100/MWh',
    'take-7': 'Across most of the world, wind potential is many times local electricity demand',
    'take-8': 'By 2050 wind still saves money, especially further from the equator',
}
SEG = {
    # T101 (the human, 9 Nov 2026: "update the scrolly so it's aligned with this storyline"): each segment shows the
    # charts article's map (same state, case and colours) and, where the text has it, the morph that makes its point
    'take-1': ([   # map-cost90, then the share of demand under $100/MWh (the text: three-quarters with wind, half without)
        card('Here we see the cost of reaching 90% uptime with solar panels and batteries alone, at one cost of capital. Pale is cheap, deep dear.', 'cost-sb'),
        card('Across the sunbelt it is already cheap. Further from the equator, long winters push the cost up.', 'cost-sb', 'world-full'),
        card('Now add wind wherever it helps. The deep blue retreats.', 'cost-wind'),
        card(None, 'cost-wind', 'world-full'),
        card('Each tile is a region, sized by the electricity it uses. Without wind, [[s1.under100.sb.demand.90|pct]] of the world\'s demand can reach 90% uptime for under $100/MWh.', dots='hist-sb'),
        card('With wind, [[s1.under100.sbw.demand.90|pct]]. The median cost falls from [[t1.sbBoth.demand.90|usd]] to [[t1.windBoth.demand.90|usd]]/MWh.', dots='hist-w'),
    ], [], 's1'),
    'take-2': ([   # map-saving
        card('Here we see how much adding wind saves on 90% uptime, in dollars per megawatt-hour. The deeper the green, the bigger the saving.', 'saving'),
        card('The savings grow with distance from the equator.', 'saving', 'north'),
        card('North of 45°N, wind cuts the median cost from [[s2.n45p.sb_demand.90|usd]] to [[s2.n45p.sbw_demand.90|usd]]/MWh.', 'saving', 'north'),
    ], [], None),
    'take-3': ([   # map-drought, then the drought chart
        card('Here we see how often solar output falls below half its average for a whole week – a solar lull. The darker, the more often.', 'drought-solar'),
        card('Solar lulls come with winter, mostly far from the equator: roughly four times a year, weighted by electricity use.', 'drought-solar', 'world-full'),
        card('Wind lulls fall elsewhere, and in other seasons: roughly eight times a year.', 'drought-wind'),
        card('Now both at once. The map nearly empties: once every ~[[dunkel.world.bothYears|int]] years, on average across the world.', 'drought-both'),
        card('Side by side, region by region: solar lulls, wind lulls and the rare weeks of both at once.', chart='drought', cs=4),
        card('The sun and the wind rarely fail together.', chart='drought', cs=4),
    ], [('drought', FIG_DROUGHT)], None),
    'take-4': ([   # map-backup
        card('Here we see the cost of meeting 99% of demand with solar, wind and batteries alone. The last hours are dear.', 'cost99'),
        card('Now build for 90% uptime and let a gas or diesel generator cover the rest. The map pales.', 'cost100'),
        card('Firm power this way costs a median [[s4.total.sbw.demand|usd]]/MWh with wind, against [[s4.total.sb.demand|usd]] without.', 'cost100', 'world-full'),
    ], [], None),
    'take-6': ([   # map-planned (the three tiers at 80% uptime)
        card('Here we see the world\'s planned coal and gas – [[s6.planned.gw|int]] GW, a dot for each region, sized by its capacity. We ask where solar, wind and batteries could reach 80% uptime.', 'planned-all'),
        card('For [[s6.local.sb.under100.80.gw|int]] GW of it, solar and batteries alone can do so for under $100/MWh.', 'planned-sb'),
        card('Add wind and that rises to [[s6.local.sbw.under100.80.gw|int]] GW – nearly all of it.', 'planned-wind'),
        card('Allow up to $130/MWh and solar, wind and batteries offer an alternative to [[s6.local.sbw.under130.80.gw|int]] of the [[s6.planned.gw|int]] GW.', 'planned-130'),
    ], [], None),
    'take-7': ([   # map-potential
        card('Here we see how many times over each region could meet its own electricity demand with wind alone, on conservative assumptions.', 'potential-cons'),
        card('Most of the map is green. Wind is not a resource for a few windy coasts.', 'potential-cons', 'world-full'),
        card('Regions that use [[s7.gw1.demand|pct]] of the world\'s electricity have at least 1 GW of wind of their own to build.', 'potential-cons', 'world-full'),
    ], [], None),
    'take-8': ([   # map-saving99 (the firm-power case, 2026 to 2050)
        card('Here we see what adding wind saves on firm power, in dollars per megawatt-hour, at today\'s costs. The deeper the green, the bigger the saving.', 'saving100y'),
        card('Scroll forward to 2050. Solar, wind and batteries all get cheaper, and far from the equator the saving from wind stays large.', 'saving100y', scrub=True),
        card('In 2050, north of 45°N, wind still saves a median [[s8bk.n45p.saving.2050|usd]]/MWh.', 'saving100y'),
    ], [], None),
}

BOX_TITLE = 'Box: What finance does to these numbers'
SECTIONS = [
    # T100 round 7 (the human's draft, 9 Nov 2026): "From cheap to firm" opens the article (id kept for the layout)
    ('two-harvests', None, 'From cheap to firm', [
        # T100: the human's rewrite of "From cheap to firm" (9 Nov 2026), word for word
        ('p', "For decades, the question about solar and wind was whether they could be cheap enough to compete with fossil power. That question is settled: across most of the world, they are now the cheapest new source of electricity, and onshore wind is the cheapest of all on global average (IRENA, 2025)."),
        ('p', "The question now is whether they can be firm – available when demand needs them, not only when the weather allows. The answer decides whether renewables replace coal and gas, or merely sit alongside them. It is the tougher test, because renewables are harvested, not mined. In China it is already policy: the renewable energy plan for 2026–2030 sets targets for the firm capacity of wind and solar paired with storage."),
        ('p', "Solar and batteries already pass much of it. In 'Harnessing the Sun', we found they could meet 80% of demand for under $100/MWh for four in five people. But solar is a single crop, and it has its bad seasons: short winter days and weeks of cloud."),
        ('p', "Wind is the second crop, and it grows in different weather. Solar follows the path of the sun. Wind follows weather systems: it often blows hardest when skies are grey and stormy, and in much of the world it is strongest in the colder months. That makes wind a natural complement to solar power."),
        ('p', "To see how far wind takes us, we added it to the atlas behind 'Harnessing the Sun' and ran every region of the world through ten years of hourly weather. We set the toughest test we could: baseload demand – the same every hour, day and night, summer and winter. Real demand is kinder, and more of it can be moved to other hours each year. So the costs here are a stress test, not a forecast: real systems should do better."),
        ('p', "Our benchmark is uptime: the share of that demand a system meets from its own solar, wind and batteries, hour by hour. We use 90%, with gas or diesel backup for the rest when the goal is fully firm power. Seven findings stand out, most of them widely underappreciated."),
    ]),
    ('take-1', 1, 'Wind cuts the cost of firm renewables by nearly a fifth', [
        ('p', "Adding wind to solar and batteries cuts the median cost of reaching 90% uptime by nearly a fifth, from [[t1.sbBoth.demand.90|usd]] to [[t1.windBoth.demand.90|usd]]/MWh."),
        ('p', "The reason is storage. The cost of firm renewables is set by the gaps: the hours, days and weeks when solar output falls short of demand. Batteries cover short gaps cheaply. Long gaps are expensive, because a battery sized for a rare shortfall sits idle most of the year."),
        ('p', "Wind fills many of these gaps directly, because its output follows weather systems rather than the sun. That cuts the storage a system needs. In Canada, the battery needed for 90% uptime shrinks from [[s2.canada.sb_batt_h.90|int]] hours of load to [[s2.canada.sbw_batt_h.90|int]]; in the US, from [[t102.batt.us.sb.90|int]] to [[t102.batt.us.sbw.90|int]]; in Europe, from [[s2.europe.sb_batt_h.90|int]] to [[s2.europe.sbw_batt_h.90|int]]; in China, from [[t102.batt.china.sb.90|int]] to [[t102.batt.china.sbw.90|int]]. Only nearer the equator does wind change little: in India the battery stays at [[t102.batt.india.sbw.90|int]] hours."),
        ('p', "With wind, three-quarters of the world's electricity demand can have 90% uptime for under $100/MWh. Without it, only half."),
        ('seg', 'take-1'),
        ('box', BOX_TITLE),
        ('p', "These costs assume the same cost of capital everywhere: [[t091.wacc.common|pct]] a year. In reality it varies widely, and it weighs heavily on solar, wind and batteries, which are paid for up front. Where the median person in Africa lives, it is [[t091.wacc.africa.people|pct]]; where the median person in Europe lives, [[t091.wacc.europe.people|pct]]."),
        ('p', "Using each region's own cost of capital changes the picture. In Europe it barely matters: the median cost of 90% uptime with wind rises from [[t091.cost.europe.common.people.90|usd]] to [[t091.cost.europe.local.people.90|usd]]/MWh. In Africa it rises from [[t091.cost.africa.common.people.90|usd]] to [[t091.cost.africa.local.people.90|usd]]/MWh. That extra $[[t100.africa.financeExtra|r10]] is the price of expensive finance, not of a poor resource: at the same cost of capital, firm power in Africa is cheaper than in Europe. The rest of this article holds the cost of capital at [[t091.wacc.common|pct]], to compare what the resource and the technology allow."),
        ('box_end', FIG_WACC),
    ]),
    ('take-2', 2, 'Wind levels out the cost of firm power across the globe', [
        # T100: the human's rewrite of section 2 (9 Nov 2026), word for word
        ('p', "Without wind, the cost of firm renewables depends on latitude. Near the equator, solar and batteries reach 90% uptime for under $60/MWh. Above 55°N, the same target costs [[s2.a55p.sb_demand.90|usd]]. Add wind, and the cost stays under $100/MWh at every latitude."),
        ('fig', FIG_LATPEOPLE),
        ('p', "Solar's gaps grow with distance from the equator: shorter days, lower sun and more overcast weather, all at their worst in winter – when wind is strongest. North of 45°N, wind cuts the median cost of 90% uptime by two-fifths, from [[s2.n45p.sb_demand.90|usd]] to [[s2.n45p.sbw_demand.90|usd]]/MWh. The same holds in the far south: in Chile and Argentina south of 40°S, wind cuts it by a third, from [[t102.south40.sb.demand.90|usd]] to [[t102.south40.sbw.demand.90|usd]]/MWh."),
        ('seg', 'take-2'),
        ('p', "The reason is the seasons. The further from the equator, the more solar output swings between summer and winter – and wind leans the other way. Across Europe, wind produces most in the dark months and least in summer, the mirror image of solar. In Germany, wind delivers [[t3.DE.windNF|pct]] of its yearly output between November and February, against [[t3.DE.solarNF|pct]] for solar. A system with both has production in every season."),
        ('fig', index_fig('chart-3', 'data-motion="hover"')),
        ('p', "That matters because much of the world's electricity is used far from the equator: [[s2.n45p.demandShare|pct]] of demand lies north of 45°N. Without wind, cheap firm power would be an advantage of the sunbelt, the band within 30° of the equator. With wind, cheap firm power is available almost everywhere electricity is used – and so are the competitive gains for energy-intensive industries that come with it."),
        ('p', "Most of the world's people live in the sunbelt, where solar and batteries are already cheap and the savings from adding wind are smaller. Beyond it, wind does the heavy lifting: it lowers the cost for three in four people more than 30° from the equator, and for almost everyone beyond 45°."),
        ('p', "The low costs are where people live, not only in deserts and on windswept plains. Where people live, the median cost of 90% uptime with wind is [[s5.med.sbw.people.90|usd]]/MWh. Add backup for the remaining hours, and more than three-quarters of the world's people live where firm solar and wind power costs under $100/MWh."),
        ('fig', FIG_PEOPLEHIST),
    ]),
    ('take-3', 3, 'Bad weeks for solar and wind rarely coincide', [
        ('p', "Even where adding wind does not make a solar and battery system cheaper, it makes supply more secure. The standing fear about the reliability of renewables is the still, grey weeks when neither the sun nor the wind delivers. They do happen. But a system with two harvests is diversified, and the two rarely fail together."),
        ('p', "Based on historical weather data, weighted by where electricity is used, solar had a lull week – output below half its average for seven consecutive days – roughly four times a year. Wind had one roughly eight times a year. Both at once: about once every four years."),
        ('seg', 'take-3'),
        ('p', "The seasons explain most of it. Almost all of Europe's solar lulls fall between November and February; only one in eight of its wind lulls does. North America is starker still: [[dunkel.na.solarInWinter|pct]] of its solar lulls fall in those months, against one in twenty of its wind lulls."),
        ('p', "Wind also shrinks the worst week. Germany's worst dark, still week of the decade leaves a gap of about five days of average demand with both sources, against six with either alone."),
        ('p', "The gain holds near the equator too, where wind saves less money. There a week-long solar lull is already rare – about once every [[dunkel.a0_15.solarYears|int]] years – and adding wind makes it rarer still."),
    ]),
    ('take-4', 4, 'Wind means less backup needs', [
        ('p', "Even two harvests fall short sometimes, and something has to cover the gap. Today that is usually a gas turbine or diesel generator that runs only when renewables and batteries cannot. The less it runs, the less fuel it burns and the less the system depends on it."),
        ('p', "Wind shrinks that gap for the same money. A solar and battery system that meets 90% of demand costs a median [[ladder.sb.90|usd]]/MWh. For less – [[ladder.sbw.95|usd]] – a system with wind meets 95% of demand, leaving the backup roughly half as much to cover. The pattern holds further up: with wind, covering 99% of demand costs about what solar and batteries pay to cover 95%."),
        ('p', "Backup remains the cheapest way to cover the final hours. A generator that sits idle most of the year costs far less than batteries sized for the rarest gaps. Much of that backup already exists: today's gas turbines and diesel generators can cover the final hours, without new plants built as a bridge (see section 5)."),
        ('seg', 'take-4'),
        ('p', "Wind also changes how much backup a system needs. For about [[ladder.bk.sb.80|usd]]/MWh, solar and batteries alone can supply 80% of demand, leaving a fifth to gas or diesel generators. Add wind, and the same money supplies 95%, leaving just a twentieth. At our 90% benchmark, firm solar and wind power costs an average [[ladder.bk.sbw.90|usd]]/MWh with wind and [[ladder.bk.sb.90|usd]] without (weighted by demand; the median with wind is [[s4.total.sbw.demand|usd]])."),
        ('fig', FIG_BKCURVE),
        ('p', "So wind brings two benefits: for the same uptime it lowers the bill, and for the same bill it cuts how much the backup has to run."),
    ]),
    ('take-5', 5, 'With wind, most planned coal and gas already has a cheaper alternative', [
        ('p', "The world has [[s6.planned.gw|int]] GW of coal and gas plants in planning. Most of it sits where firm renewables are already the cheaper option. On the 80% uptime bar used in 'Harnessing the Sun', solar and batteries alone offer an alternative under $100/MWh to [[s6.local.sb.under100.80.share|pct]] of the pipeline. With wind, [[s6.local.sbw.under100.80.share|pct]]."),
        ('seg', 'take-6'),
        ('p', "The higher the bar, the more wind matters. At 90% uptime, it raises the share from [[s6.local.sb.under100.90.share|pct]] to [[s6.local.sbw.under100.90.share|pct]]; in China alone, it gives another [[t100.china.extra90|int]] GW a cheaper alternative. For firm solar and wind power, with backup, five-sixths of the pipeline ([[s6.local.sbw.bk90.under100.gw|int]] GW) sits where firm renewables cost under $100/MWh – against under two-thirds ([[s6.local.sb.bk90.under100.gw|int]] GW) without wind."),
        ('fig', FIG_PLANHIST),
        ('p', "These are alternatives for meeting the same demand in the model, not like-for-like replacements of each plant's grid services. But for anyone financing a coal or gas plant meant to run for decades, the comparison is the one that matters: in most places, it already has a cheaper alternative that can deliver firm power."),
        ('p', "And the gap is widening. The disruption in the Strait of Hormuz has pushed gas and coal prices sharply higher, and they are likely to stay there for a while: the cost of power from new coal and gas plants is heading above $100/MWh, and in many importing countries well above it. Solar, wind and batteries are moving the other way, getting cheaper as more are built."),
    ]),
    ('take-6', 6, 'There is plenty of wind almost everywhere', [
        ('p', "Two objections remain. The first: is there enough wind? There is. On conservative assumptions, global wind potential is at least [[t2.multCons|floor]] times the world's electricity demand. And it is not confined to a few windy coasts."),
        ('seg', 'take-7'),
        ('p', "Regions that use [[s7.gw1.demand|pct]] of the world's electricity have at least 1 GW of wind they could build on their own land and coast; regions with [[s7.gw10.demand|pct]] have at least 10 GW. Most of the people in regions with less live where solar and batteries alone are already the cheapest route to firm renewables."),
        ('p', "We will not run out of wind."),
    ]),
    ('take-7', 7, 'Cheaper solar will not price wind out', [
        ('p', "The second objection: solar and batteries keep getting cheaper, so will wind still be worth adding? It will. Wind is on its own learning curve: onshore wind's installed cost has fallen [[ext.lr.onshore_wind.Global|pct]] with each doubling of capacity. On the atlas's local cost paths, the cost of firm solar and wind power falls from [[s8bk.med.sbw.demand.2026|usd]] to [[s8bk.med.sbw.demand.2050|usd]]/MWh by 2050."),
        ('seg', 'take-8'),
        ('p', "In 2050, adding wind still lowers the cost of firm solar and wind power for regions using two-thirds of the world's electricity. North of 45°N, it still saves a median [[s8bk.n45p.saving.2050|usd]]/MWh. Cheaper batteries make each hour of storage cheaper. Wind reduces how many hours are needed, and that advantage does not disappear."),
        ('fig', FIG_BANDSAVE),
    ]),
    ('conclusion', None, 'A system built on harvests', [
        # T100: the human's rewrite of the close (9 Nov 2026), word for word
        ('p', "For two centuries we have gathered energy that nature had already stored – coal seams, oil fields, gas reservoirs. The fuel came with its own storage, so supply could follow demand. It also came with a price set in someone else's market, as the Hormuz crisis has shown again."),
        ('p', "Solar and wind make us farmers. They produce in place, and their yield rises and falls with the weather and the seasons. The harvest has to be stored, or demand moved to meet it. That changes the design question: not which single source can run all the time, but which combination leaves the smallest gaps."),
        ('p', "Solar supplies the cheapest power when the sun shines. Batteries carry it into the night. Wind produces in the weather and seasons when solar does not. A little backup from existing gas and diesel plants covers the rare weeks when all three come up short – and longer-duration storage, flexible demand and existing hydro will shrink that role further."),
        ('p', "That last stretch is not today's problem. Wind and solar supplied [[ext.windSolarShare2025|pct]] of the world's electricity in 2025. Today's technology, at today's costs, can take that to 80% and beyond, and in much of the world to 90% or 95%. The task now is to build – and to build as farmers do. And the first lesson of farming is the oldest: never rely on a single crop."),
    ]),
]

# The opening summary (the human's draft, 9 Nov 2026): three key highlights, each a big number and the sentence it begins;
# no key findings list (the draft has none)
HIGHLIGHTS = [
    ('~$[[t100.hl.saving90|r10]]/MWh', 'cost reduction from adding wind to solar and batteries: the median cost of meeting 90% of demand falls from [[t1.sbBoth.demand.90|usd]] to [[t1.windBoth.demand.90|usd]]/MWh.'),
    ('[[s4.total.sbw.demand|usd]]/MWh', 'median cost of firm solar and wind power, covering all demand with batteries and a little backup.'),   # weighted by demand (the human)
    ('Once every ~[[dunkel.world.bothYears|int]] years', 'a solar and a wind lull strike in the same week – a Dunkelflaute, German for a dark, windless lull – on average across the world, weighted by electricity demand. A solar lull alone comes roughly four times a year.'),
]
FINDINGS = []

STAGE = '''
                    <div class="scrolly__stage" id="visual">
                        <div class="smap" id="map" role="img" aria-label="World map of the atlas's regions, coloured by the measure each card describes"></div>
                        <div class="map-key">
                            <div class="map-caption" id="map-caption" aria-live="polite">
                                <div class="map-caption-title" id="map-title"></div>
                                <div class="map-caption-sub" id="map-sub"></div>
                            </div>
                            <div class="map-legend" id="map-legend"></div>
                        </div>
                        <div class="map-status" id="map-status" hidden></div>
                        <div class="map-tooltip" id="map-tooltip" hidden></div>
                    </div>'''


def render_seg(sid, no):
    cards, panels, dots_set = SEG[sid]
    steps = []
    for k, c in enumerate(cards):
        attrs = (f' data-chart="{c["chart"]}" data-chart-step="{c["cs"]}"' if c['chart'] else '') + \
                (f' data-dots="{c["dots"]}"' if c['dots'] else '') + \
                (f' data-state="{c["state"]}" data-view="{c["view"]}"' if c['state'] else '') + (' data-year-scrub' if c['scrub'] else '')
        visual = (f'chart {c["chart"]} (step {c["cs"]})' if c['chart'] else f'dots: {c["dots"]}' if c['dots']
                  else f'map {c["state"]}, {c["view"]}' + (', year follows scroll' if c['scrub'] else ''))
        if c['text'] is None:
            steps.append(f'                    <div class="step step--picture"{attrs} aria-hidden="true"></div>')
            cards_md.append(f'| {sid} | {k + 1} | {visual} | (picture only) |')
        else:
            t = bind(c['text'])
            steps.append(f'                    <div class="step"{attrs}>\n'
                         f'                        <div class="card"><p class="card__lead">{t}</p></div>\n'
                         f'                    </div>')
            cards_md.append(f'| {sid} | {k + 1} | {visual} | {reads(t)} |')
    if cards[-1]['text'] is None:
        mismatch.append(f'segment {sid} must end on a takeaway card')
    if not cards[0]['text'].startswith('Here we see'):
        mismatch.append(f'segment {sid}: the first card starts "Here we see"')
    pan = ''.join(f'\n                    <div class="seg__chart" data-chart-panel="{cid}">{fig}</div>' for cid, fig in panels)
    title = SEG_TITLES.get(sid)
    return (f'<div class="seg" data-seg="{no}"' + (f' data-dots-set="{dots_set}"' if dots_set else '') + (f' data-seg-title="{H.escape(title)}"' if title else '') + '>\n'
            f'                <div class="seg__slot">{STAGE if no == 0 else ""}{pan}\n'
            f'                </div>\n'
            f'                <div class="seg__steps">\n' + '\n'.join(steps) + '\n'
            f'                </div>\n'
            f'            </div>')


def render_sections():
    out, seg_no = [], 0
    for sid, num, head, blocks in SECTIONS:
        parts = [f'<section class="take take--linear" id="{sid}">']
        if num:
            parts.append(f'<div class="take-number">{num}</div>')
        parts.append(f'<h2>{head}</h2>')
        for kind, body in blocks:
            if kind == 'p':
                parts.append(P(body))
            elif kind == 'seg':
                parts.append(render_seg(body, seg_no))
                seg_no += 1
            elif kind == 'fig':
                parts.append(body)
            elif kind == 'h3':   # T100: the finance box's heading (### in the draft)
                if f'### {body}' not in DRAFT:
                    mismatch.append(f'box heading: {body}')
                parts.append(f'<h3 class="box-title">{body}</h3>')
            elif kind == 'box':   # T101: the finance box folds, as on charts.html (open while its map draws, story.js)
                if f'### {body}' not in DRAFT:
                    mismatch.append(f'box heading: {body}')
                parts.append('<details class="fold-box" id="finance-box" open><summary><span class="fold-box__label">Box</span> '
                             + body.replace('Box: ', '') + '</summary><div class="fold-box__body">')
            elif kind == 'box_end':
                parts.append(body + '</div></details>')
        out.append('\n            '.join(parts) + '\n        </section>')
    return '\n\n        '.join(out)


body = render_sections()
heads = [md_plain(h) for h in re.findall(r'^## (?:\d+\. )?(.+)$', DRAFT, re.M)]
for sid, num, head, _ in SECTIONS:
    if head not in heads:
        mismatch.append(f'heading: {head}')

hl_html, find_html = [], []
for big, text in HIGHLIGHTS:
    big_b, t = bind(big), bind(text)
    r = reads(f'{big_b} {t}')
    if r not in DRAFT_PARAS:
        mismatch.append(r)
    used.add(r)
    big_html = re.sub(r'<span data-n', '<span data-count data-n', big_b)
    hl_html.append(f'''                    <li class="highlight">
                        <p class="highlight__num">{big_html}</p>
                        <p class="highlight__text">{t}</p>
                    </li>''')
for title, text in FINDINGS:
    t = bind(text)
    r = reads(f'{title} {t}')
    if r not in DRAFT_PARAS:
        mismatch.append(r)
    used.add(r)
    find_html.append(f'''                    <li class="finding">
                        <span class="finding__no" aria-hidden="true"></span>
                        <div class="finding__body">
                            <h3 class="finding__title">{title}</h3>
                            <p class="finding__text">{t}</p>
                        </div>
                    </li>''')
FINDINGS_HTML = f'''<section class="findings" aria-labelledby="highlights-title">
            <div class="wrap">
                <h2 id="highlights-title">Key highlights</h2>
                <div class="tbar" aria-hidden="true"></div>
                <ul class="highlights__list">
{chr(10).join(hl_html)}
                </ul>
            </div>
        </section>'''

standfirst_md = md_plain(re.search(r'^\*\*(.+?)\*\*$', DRAFT, re.M).group(1))
byline_md = md_plain(re.search(r'^By .+$', DRAFT, re.M).group(0))
if standfirst_md not in DRAFT_PARAS or byline_md not in DRAFT_PARAS:
    mismatch.append('standfirst or byline')
used.update([standfirst_md, byline_md])
missing = [p for p in DRAFT_PARAS if p not in used]
if mismatch or missing:
    raise SystemExit('story-build: text differs from the draft\n  changed: ' + '\n  changed: '.join(mismatch)
                     + '\n  not placed: ' + '\n  not placed: '.join(missing))

SOURCES_LIST = None   # T100: the human's list (below)

# The notes, cut to the essentials (the human, 9 Nov 2026: "SO much shorter"); the full method, data and caveats are in
# the atlas's How it works panel (deployment/index.html), which keeps the long disclosures (D-154, D-155: the calibration
# countries, the Global Wind Atlas validation) and the potential definitions.
NOTES = [
    ('note-demand', "<strong>Costs.</strong> Every figure comes from the atlas's model at 2026 costs, with each region's local "
     "equipment costs and one cost of capital everywhere, [[p.wacc|pct]], a real rate: costs are in constant 2026 dollars and no "
     "inflation is applied. Only the finance box in point 1 uses each region's own rate, from Hatton et al. (2025). Solar and wind "
     "plants are taken as lasting 30 years and batteries 20. Shares and medians are weighted by electricity demand (Chen et al. 2022) "
     "unless the text says people (GPW v4). Section 7 follows the atlas's cost paths to 2050, with backup equipment and fuel held at today's prices."),
    ('note-uptime', "<strong>Uptime</strong> is the share of a year's demand that a build meets, hour by hour, against a flat "
     "baseload – the same load every hour – averaged over ten weather years (2015–2024). It is not the share of hours. With "
     "backup, the cheaper of a gas turbine or a diesel generator covers the remaining hours; costs are per MWh of the full load."),
    ('note-wind', "<strong>Wind.</strong> Each region has one simulated wind site on the windiest fifth of its eligible land or "
     "sea, outside protected areas and settlements. Its output is scaled to the capacity factors IRENA observed for new wind "
     "farms (×0.879 onshore in Europe, ×0.777 offshore), standing in for losses such as wakes that the model does not "
     "represent. The Global Wind Atlas it rests on has known regional biases, documented by Gruber et al. (2022) and Peña-Sánchez et al. (2026)."),
    ('note-droughts', "<strong>Lulls.</strong> A lull week is a run of seven days in which a source's output falls below "
     "half its average over the ten weather years. Frequencies are global and demand-weighted; the interval in any one place differs."),
    ('note-potential', "<strong>Wind potential</strong> is a range. The conservative case uses 3 MW per km², new-build capacity "
     "factors and a 20% cut-off on the scaled capacity factor, with offshore on the World Bank/ESMAP definition. The technical "
     "case uses 5 MW per km² and the IEA's offshore definition."),
    ('note-planned', "<strong>Planned coal and gas</strong> is Global Energy Monitor's announced capacity, counted where a "
     "region's cheapest build reaches the stated uptime for $100/MWh or less (or, for the last tier, $130/MWh or less). An "
     "alternative means meeting the same demand in the model, not replicating each plant's grid services."),
]
notes = ('<section class="notes" id="notes">\n                <h2 class="label">Notes and method</h2>\n                <ol>\n'
         + '\n'.join(f'                    <li id="{i}">{bind(t)}</li>' for i, t in NOTES)
         + '\n                </ol>\n                <p class="notes__more">The full method, data and caveats are in the '
         "atlas's How it works panel.</p>\n            </section>")
# The sources: the human's draft of 9 Nov 2026, word for word (T100)
sources = '''<footer class="sources">
                <h2 class="label">Sources</h2>
                <ul>
                    <li>Ember, Solar + Wind + Battery Atlas (2026): solar from NASA POWER hourly weather, 2015–2024; wind from Global Wind Atlas 4 (DTU Wind Energy and the World Bank, 2025) and ERA5 (Copernicus Climate Change Service).</li>
                    <li>Peña-Sánchez, E. U., Dunkel, P., Winkler, C. et al. (2026), Towards high resolution, validated and open global wind power assessments, Nature Communications 17, 539; Gruber, K., Regner, P., Wehrle, S., Zeyringer, M. and Schmidt, J. (2022), Towards global validation of wind power simulations, Energy 238, 121520: validation and known biases of the Global Wind Atlas.</li>
                    <li>World Bank / ESMAP (2021), Global Offshore Wind Technical Potential.</li>
                    <li>IEA (2019), Offshore Wind Outlook 2019: offshore technical potential.</li>
                    <li>Eurek, K. et al. (2017), An improved global wind resource estimate for integrated assessment models, Energy Economics 64; Denholm, P. et al. (2009), Land-Use Requirements of Modern Wind Power Plants in the United States, NREL: wind potential context.</li>
                    <li>Korfiati, A. et al. (2016), Estimation of the global solar energy potential and photovoltaic cost with the use of open data; Chinese Academy of Sciences (2026): solar potential context.</li>
                    <li>UNEP-WCMC and IUCN (2026), World Database on Protected Areas, October 2026: protected-area exclusions.</li>
                    <li>Buchhorn, M. et al. (2020), Copernicus Global Land Service: Land Cover 100 m, epoch 2019, Zenodo, doi:10.5281/zenodo.3939050: forest and cropland sensitivity.</li>
                    <li>European Commission, Joint Research Centre, Global Human Settlement Layer, GHS-BUILT-S (2020): settlement exclusions.</li>
                    <li>IRENA (2026), Renewable Energy Statistics 2026: capacity factors of new wind farms, for the level calibration.</li>
                    <li>Global Solar Atlas (World Bank Group / Solargis): annual solar yield for the calibration, and technical solar potential.</li>
                    <li>World Bank / ESMAP and Solargis (2020), Global Photovoltaic Power Potential by Country: Level 1 and Level 2 land for solar potential.</li>
                    <li>Bolinger, M. and Bolinger, G. (2022), Land Requirements for Utility-Scale PV: An Empirical Update on Power and Energy Density, IEEE Journal of Photovoltaics, LBNL; Joshi, S. et al., rooftop solar potential: solar density and rooftop context.</li>
                    <li>IRENA (2026), Renewable Power Generation Costs in 2025.</li>
                    <li>Chinese Wind Energy Association (2025), statistics on wind turbine installations and exports in 2024: export markets for the Gulf and Central Asia cost proxy.</li>
                    <li>Danish Energy Agency, Technology Catalogue (offshore wind cost path).</li>
                    <li>Hamilton, Millstein, Bolinger, Wiser and Jeong (2020), How does wind project performance change with age in the United States?, Joule 4 (wind output degradation).</li>
                    <li>Ember (2026), Yearly Electricity Data and Monthly Electricity Data; Ember (2026), Global Electricity Review 2026: wind and solar 17.3% of world electricity in 2025.</li>
                    <li>Hatton, L., Staffell, I., Jansen, M. et al. (2025), Historical and future projected costs of capital for ten energy technologies across 176 countries, Scientific Data 12, 1912.</li>
                    <li>NASA SEDAC, Gridded Population of the World, v4 (2020).</li>
                    <li>Chen, J. et al. (2022), Global 1 km × 1 km gridded revised real gross domestic product and electricity consumption during 1992–2019, Scientific Data 9, 202.</li>
                    <li>Ember (2025), Harnessing the Sun.</li>
                    <li>Global Energy Monitor (2024), Global Coal Plant Tracker and Global Oil and Gas Plant Tracker: planned capacity.</li>
                    <li>International Gas Union (2024), Wholesale Gas Price Survey: gas prices for backup.</li>
                    <li>IEA (2026), Gas Market Report, Q2 2026: LNG supply lost to the Strait of Hormuz disruption.</li>
                    <li>IEA (2026), Coal Mid-Year Update 2026: coal switching and prices.</li>
                </ul>
            </footer>'''

ABOUT = '''<section class="about" id="about">
            <h2>About this article</h2>
            <p>Written by the authors named above. The interactive maps, charts and page code were developed with the assistance of Claude, an AI model by Anthropic, and reviewed by the authors. As per Ember's AI use policy, responsibility for the quality and accuracy of the output lies with the authors.</p>
        </section>'''

title_md = re.search(r'^# (.+)$', DRAFT, re.M).group(1)
meta = ' '.join(sentences_of(standfirst_md)[:2])
html = f'''<!DOCTYPE html>
<html lang="en-GB">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title_md} | Solar + Wind + Battery Atlas</title>
    <!-- T087: built by scripts/article/tools/story-build.py from team/reports/T087-article-v2.md (the approved
         text, word for word); every number is a bound span, checked by verify-article. Edit the builder, not this file. -->
    <meta name="description" content="{H.escape(meta)} An interactive Ember analysis.">

    <!-- Everything is served from this site: no fonts, scripts or styles from another host. -->
    <link rel="preload" href="fonts/poppins-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="fonts/poppins-latin-600-normal.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="modulepreload" href="js/story.js">
    <link rel="modulepreload" href="js/story-map.js">
    <link rel="modulepreload" href="js/story-layers.js">
    <link rel="modulepreload" href="js/story-charts.js">
    <link rel="modulepreload" href="js/summary.js">
    <link rel="modulepreload" href="js/layers.js">
    <link rel="modulepreload" href="js/map.js">
    <link rel="modulepreload" href="js/format.js">
    <link rel="modulepreload" href="js/charts.js">
    <link rel="modulepreload" href="../js/constants.js">
    <link rel="preload" href="data/article-summary.json" as="fetch" crossorigin>
    <link rel="preload" href="../data/world.geojson" as="fetch" crossorigin>
    <meta name="color-scheme" content="light">
    <link rel="stylesheet" href="css/story.css">
</head>

<body class="story">
    <div class="progress" aria-hidden="true"><span></span></div>

    <article class="article" id="article">

        <header class="opening" id="top">
            <div class="opening__map" aria-hidden="true"><canvas id="opening-map"></canvas></div>
            <div class="opening__legend" id="opening-legend" hidden></div>
            <div class="opening__inner">
                <h1>{title_md}</h1>
                <div class="tbar" aria-hidden="true"></div>
                <p class="standfirst">{bind(standfirst_md.replace('three-quarters', 'three-quarters'))}</p>
                <p class="byline">{byline_md}</p>
                <svg class="opening__cue" viewBox="0 0 16 10" aria-hidden="true"><path d="M1 1.5l7 7 7-7" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>
            </div>
        </header>

        {FINDINGS_HTML}

        {body}

        {notes}

        {sources}

        {ABOUT}
    </article>

    <script src="vendor/d3.v7.9.0.min.js"></script>
    <script src="vendor/gsap.min.js"></script>
    <script src="vendor/ScrollTrigger.min.js"></script>
    <script type="module" src="js/story.js"></script>
</body>

</html>
'''
CLEAN_OK = 'existing clean resources on the grid'   # T100: the human's draft, 9 Nov 2026 (flagged to the lead)
if re.search(r'\bclean', html.replace(CLEAN_OK, ''), re.I):
    raise SystemExit('story-build: the word "clean" is in story.html: ' + ', '.join(sorted(set(m.group(0) for m in re.finditer(r'.{40}\bclean.{20}', html, re.I))))[:600])
CARDS_MD = ROOT / 'team/reports/T087-cards.md'
cards_text = ("# T087 – the map segments' cards, for review\n\n"
              'Written by `scripts/article/tools/story-build.py` (edit the cards there). Numbers read as the page binds them '
              'from the summary. Each segment: a pinned visual, 2–4 steps including a picture-only beat, the last card the takeaway.\n\n'
              '| Section | Card | Visual | Text |\n|---|---|---|---|\n' + '\n'.join(cards_md) + '\n')
import sys


def main():
    if '--check' in sys.argv:
        if not CARDS_MD.exists() or CARDS_MD.read_text() != cards_text:
            raise SystemExit('team/reports/T087-cards.md differs from the cards in story-build.py (run it to rewrite)')
        if OUT.read_text() != html:
            raise SystemExit('scrollytelling/index.html differs from what story-build.py gives (run it to rebuild)')
        print(f'is what story-build.py gives: {len(used)} paragraphs of the approved text word for word, every number bound to the summary')
        raise SystemExit(0)
    OUT.write_text(html)
    CARDS_MD.write_text(cards_text)
    print(f'wrote {OUT.relative_to(ROOT)}: {len(html):,} bytes; {len(used)} draft paragraphs placed word for word, every number bound')


# T091: charts-build.py imports this module for the text, figures, notes and sources (the charts-only version);
# importing builds and checks everything above but writes nothing.
if __name__ == '__main__':
    main()
