/**
 * Tooltip and popup utilities
 */
import { worstYearLine } from './worst.js';

// The LCOE view's technology filter (T074), set by app.js: null with all four
// technologies on, else { text: 'Solar + battery only', noWind: what the saving
// from wind is measured against ('' = no build without wind) }.
let techFilter = null;
export function setTechFilterNote(note) { techFilter = note || null; }
export function getTechFilterNote() { return techFilter; }

// T082: offshore-alone LCOE without the export link, where the grid operator builds it; set by app.js.
let offshoreTenderLcoe = () => null;
export function setOffshoreTenderLcoe(fn) { offshoreTenderLcoe = fn; }

/** "Offshore alone, as tendered (export link by the grid operator): $88/MWh" for builds with offshore wind. */
export function offshoreTenderLine(data, formatCurrency) {
    if (!data?.wind_gw || data.wind_surface === 'on') return '';
    const v = offshoreTenderLcoe(data.location_id);
    return Number.isFinite(v)
        ? `<div class="text-muted">Offshore alone, as tendered (export link by the grid operator): ${formatCurrency(v)}/MWh</div>`
        : '';
}

/** The filter line of a cost tooltip ('' with every technology on). */
export function techFilterLine() {
    return techFilter ? `<div class="text-muted">${techFilter.text}</div>` : '';
}

/** A cost cell with no eligible build under the filter (T074): the "target not met" state. */
export function noBuildTooltip(valueLine, extraLines = []) {
    return buildTooltipHtml(valueLine, [
        '<div class="text-amber-300">Target not met: no eligible build</div>',
        techFilterLine(),
        ...extraLines
    ]);
}

/**
 * Create a shared Leaflet popup with consistent styling
 */
export function createSharedPopup() {
    return L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });
}

/**
 * Build tooltip HTML content with consistent styling
 * @param {string} title - Main title text
 * @param {string[]} lines - Array of HTML line strings (falsy values filtered out)
 */
export function buildTooltipHtml(title, lines = []) {
    const linesHtml = lines.filter(Boolean).join('\n');
    return `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
        <div class="font-semibold">${title}</div>
        ${linesHtml}
    </div>`;
}

/** A battery size in MWh per MW of load, with thousands separators ("4,608"); an
 *  interpolated (fractional) size from the add-on builds (T058) rounded up to a whole MWh. */
export function formatBattery(battGwh) {
    if (!Number.isFinite(battGwh)) return `${battGwh}`;
    return Math.ceil(battGwh).toLocaleString('en-US');
}

/** "5 MW_DC solar + 3 MW onshore wind + 8 MWh storage" (wind only when > 0). A
 *  combined build (surface 'both') names both: pass `split` = { on, off }. */
export function formatBuild(solarGw, windGw, battGwh, surface, split = null) {
    const parts = [`${solarGw} MW_DC solar`];
    if (surface === 'both' && split) {
        parts.push(`${split.on} MW onshore wind`, `${split.off} MW offshore wind`);
    } else if (windGw) {
        parts.push(`${windGw} MW ${surface === 'off' ? 'offshore' : 'onshore'} wind`);
    }
    parts.push(`${formatBattery(battGwh)} MWh storage`);
    return parts.join(' + ');
}

/** " | Wind 3 MW onshore" for a build line, or '' without wind; a combined build
 *  " | Wind 2 MW onshore + 1 MW offshore" (`split` = { on, off }). */
export function formatWindPart(windGw, surface, split = null) {
    if (surface === 'both' && split) return ` | Wind ${split.on} MW onshore + ${split.off} MW offshore`;
    return windGw ? ` | Wind ${windGw} MW ${surface === 'off' ? 'offshore' : 'onshore'}` : '';
}

/** A cost row's onshore/offshore split, or null unless it is a combined build. */
export function windSplitOf(data) {
    return data?.wind_surface === 'both' ? { on: data.wind_on_gw, off: data.wind_off_gw } : null;
}

/**
 * The line naming an add-on winner (T058), or '' for any other row: a large
 * build "Solar S MW + battery B MWh – beyond the slider range, interpolated" (or
 * "…, simulated"), a combined build "Solar S + onshore a + offshore b MW + battery B MWh".
 */
export function addonBuildText(data) {
    if (data?.addon === 'large') {
        return `Solar ${data.solar_gw} MW + battery ${formatBattery(data.batt_gwh)} MWh \u2013 beyond the slider range, ${data.interpolated ? 'interpolated' : 'simulated'}`;
    }
    if (data?.addon === 'wind_mix') {
        return `Solar ${data.solar_gw} + onshore ${data.wind_on_gw} + offshore ${data.wind_off_gw} MW + battery ${formatBattery(data.batt_gwh)} MWh`;
    }
    return '';
}

export function addonBuildLine(data) {
    const text = addonBuildText(data);
    return text ? `<div class="text-muted">${text}</div>` : '';
}

/**
 * Which wind surface a cost view chose for a cell, and why. Rows say what was
 * searched (`windSurfaces`): 'both' surfaces, 'onshore' only (offshore excluded),
 * or only the 'slice' on screen (before the full grid loads, so no comparison).
 * Searching both, the winner is the cheaper build where the search ranks by cost
 * (target CF met; target LCOE missed; target LCOE with firm backup, where every
 * build is firm) and the higher CF where it ranks by CF; the other surface lost,
 * unless it has no viable site. `sites` is the cell's wind resource row
 * ({ on_viable, off_viable }) or null. Plain text; '' when the build has no wind.
 */
export function costWindSurfaceText(data, sites) {
    if (!data?.wind_gw) return '';
    if (data.wind_surface === 'both') return 'Onshore and offshore wind combined.';
    const off = data.wind_surface === 'off';
    const chosen = off ? 'Offshore' : 'Onshore';
    const other = off ? 'onshore' : 'offshore';
    if (data.windSurfaces === 'onshore') return 'Onshore wind (offshore excluded).';
    if (data.windSurfaces !== 'both') return `${chosen} wind at the level on screen (surfaces are compared once all wind data has loaded).`;
    if (sites && !(off ? sites.on_viable : sites.off_viable)) return `${chosen} wind: no viable ${other} site here.`;
    const byCost = Number.isFinite(data.targetLcoe)
        ? data.targetLcoeMet === false || Boolean(data.includeDieselBackup)
        : data.meetsTarget !== false;
    return `${chosen} wind: ${byCost ? 'cheaper' : 'higher CF'} than ${other} here.`;
}

export function costWindSurfaceLine(data, sites) {
    const text = costWindSurfaceText(data, sites);
    // Every cost row says what was searched (windSurfaces); those tooltips also state the filter.
    const filter = data && data.windSurfaces !== undefined ? techFilterLine() : '';
    return (text ? `<div class="text-muted">${text}</div>` : '') + filter;
}

/** CF tooltip for a capacity-factor map; `extraLines` (HTML) follow the build line. */
export function buildCfTooltip(cf, solarGw, battGwh, windGw = 0, surface = 'on', extraLines = [], split = null, row = null) {
    const cfPct = (cf * 100).toFixed(1);
    return buildTooltipHtml(
        `Capacity factor ${cfPct}%`,
        [`<div class="text-muted">Share of a constant 1\u00a0MW baseload supplied, averaged over 2015\u20132024, by ${formatBuild(solarGw, windGw, battGwh, surface, split)}.</div>`,
            row ? worstYearLine({ ...row, solar_gw: solarGw, batt_gwh: battGwh, wind_gw: windGw, wind_surface: surface }) : '',
            ...extraLines]
    );
}

/**
 * The highest-CF build of a cost-view row (shown where the target CF is missed),
 * e.g. "10 MW_DC solar + 8 MW offshore wind + 36 MWh storage". Where the target
 * is missed the row itself is that build (both search paths pick the same one),
 * so the wind surface is the row's; if the wind levels differ it is left unnamed.
 */
export function formatMaxConfig(data) {
    const wind = data?.maxConfigWind || 0;
    const parts = [`${data?.maxConfigSolar ?? '--'} MW_DC solar`];
    if (wind && data.maxConfigSurface === 'both') {
        parts.push(`${data.maxConfigWindOn} MW onshore wind`, `${data.maxConfigWindOff} MW offshore wind`);
    } else if (wind) {
        const surface = wind === data.wind_gw ? (data.wind_surface === 'off' ? 'offshore ' : 'onshore ') : '';
        parts.push(`${wind} MW ${surface}wind`);
    }
    parts.push(`${data?.maxConfigBatt ?? '--'} MWh storage`);
    return parts.join(' + ');
}

export function formatFirmCfText(data) {
    const firmCf = Number.isFinite(data?.firm_cf) ? data.firm_cf : data?.annual_cf;
    const solarShareCf = Number.isFinite(data?.solar_share_cf) ? data.solar_share_cf : data?.annual_cf;
    if (!Number.isFinite(firmCf)) return '--';

    const firmPct = (firmCf * 100).toFixed(1);
    if (!data?.includeDieselBackup) {
        return `${firmPct}%`;
    }

    const solarPct = Number.isFinite(solarShareCf) ? (solarShareCf * 100).toFixed(1) : '--';
    return `${firmPct}% (${solarPct}% from ${data?.wind_gw ? 'solar and wind' : 'solar'})`;
}

export function buildDieselBackupLines(data, formatCurrency) {
    if (!data?.includeDieselBackup) return [];

    const lines = [];
    const fuel = data.backup_fuel === 'gas' ? 'gas' : 'diesel';
    const fuelLabel = fuel === 'gas' ? 'OCGT gas' : 'diesel';
    const shareCf = Number.isFinite(data.backup_share_cf) ? data.backup_share_cf : data.diesel_share_cf;
    if (Number.isFinite(shareCf)) {
        // The backup serves the hours the build misses and what the renewables lose
        // to ageing (the levelised degradation), so the two parts add up to its share.
        const buildCf = Number.isFinite(data.solar_share_cf) ? data.solar_share_cf : data.annual_cf;
        const missPct = Number.isFinite(buildCf) ? Math.max(0, 1 - buildCf) * 100 : NaN;
        const shareTxt = (shareCf * 100).toFixed(1);
        const missTxt = Number.isFinite(missPct) ? missPct.toFixed(1) : '';
        const ageTxt = missTxt ? (Number(shareTxt) - Number(missTxt)).toFixed(1) : '';
        const split = ageTxt && Number(ageTxt) > 0
            ? `: ${missTxt}% the build misses and ${ageTxt}% lost to ageing, on average over its life`
            : '';
        lines.push(`<div class="text-muted">Backup (${fuelLabel}, least-cost) covers ${shareTxt}% of annual energy${split}.</div>`);
    }
    if (fuel === 'gas' && Number.isFinite(data.gas_price_usd_per_mmbtu)) {
        const sourceCountry = data.gas_source_country_name || 'regional market';
        lines.push(`<div class="text-muted">Gas price: ${formatCurrency(data.gas_price_usd_per_mmbtu, 2)}/MMBtu • IGU 2024, ${sourceCountry}</div>`);
    } else if (fuel === 'diesel' && Number.isFinite(data.diesel_price_usd_per_liter)) {
        const yearNote = Number.isFinite(data.diesel_source_year) ? ` (${data.diesel_source_year})` : '';
        const sourceCountry = data.diesel_source_country_name || 'source country';
        const sourceKind = data.diesel_source_type === 'nearest_country'
            ? `nearest-country fallback from ${sourceCountry}`
            : `local source for ${sourceCountry}`;
        const distanceNote = data.diesel_source_type === 'nearest_country' && Number.isFinite(data.diesel_source_distance_km)
            ? `, ${data.diesel_source_distance_km.toFixed(0)} km`
            : '';
        lines.push(`<div class="text-muted">Diesel price: ${formatCurrency(data.diesel_price_usd_per_liter, 2)}/L${yearNote} • ${sourceKind}${distanceNote}</div>`);
    }
    const adder = Number.isFinite(data.backup_lcoe_adder) ? data.backup_lcoe_adder : data.diesel_lcoe_adder;
    if (Number.isFinite(adder)) {
        lines.push(`<div class="text-muted">${fuel === 'gas' ? 'Gas (OCGT)' : 'Diesel'} adds ${formatCurrency(adder, 1)}/MWh to total LCOE.</div>`);
    }
    return lines;
}

/**
 * Build an LCOE tooltip
 */
export function buildLcoeTooltip(data, formatCurrency, formatNumber, windSites = null) {
    if (data?.noEligibleBuild) return noBuildTooltip('LCOE: --/MWh');
    const valueLine = data.meetsTarget || data.includeDieselBackup
        ? `LCOE: ${Number.isFinite(data.lcoe) ? formatCurrency(data.lcoe) : '--'}/MWh`
        : `LCOE: ${Number.isFinite(data.maxConfigLcoe) ? `>${formatCurrency(data.maxConfigLcoe)}` : '--'}/MWh`;

    const lines = [
        `<div>CF ${formatFirmCfText(data)} | Solar ${data.solar_gw} MW_DC${formatWindPart(data.wind_gw, data.wind_surface, windSplitOf(data))} | Battery ${formatBattery(data.batt_gwh)} MWh</div>`,
        worstYearLine(data),
        addonBuildLine(data),
        costWindSurfaceLine(data, windSites)
    ];
    if (Number.isFinite(data.windSaving) && data.wind_gw) {
        const saving = data.windSaving;
        lines.push(saving > 0.5
            ? `<div class="text-wind">Wind cuts the cost by ${formatCurrency(saving)}/MWh here.</div>`
            : `<div class="text-muted">Wind makes little difference to cost here.</div>`);
    }
    lines.push(offshoreTenderLine(data, formatCurrency));
    lines.push(...buildDieselBackupLines(data, formatCurrency));

    if (!data.meetsTarget) {
        if (data.includeDieselBackup) {
            lines.push(`<div class="text-amber-300">Target not met – showing the highest-share firm build</div>`);
        } else {
            lines.push(`<div class="text-amber-300">Target not met</div>`);
            lines.push(`<div>Highest-CF build: ${formatMaxConfig(data)}</div>`);
        }
    }

    return buildTooltipHtml(valueLine, lines);
}

/**
 * Build a population tooltip
 */
export function buildPopulationTooltip(popVal, formatNumber, additionalLines = []) {
    return buildTooltipHtml(
        `Population: ${formatNumber(popVal, 0)}`,
        additionalLines
    );
}

/**
 * Build a plant tooltip
 */
export function buildPlantTooltip(plant, formatNumber, capitalizeWord) {
    const cap = formatNumber(plant.capacity_mw || 0, 0);
    return buildTooltipHtml(
        plant.plant_name || 'Power plant',
        [
            `<div>${(plant.fuel_group || '').toUpperCase()} • ${cap} MW</div>`,
            `<div class="text-muted">${capitalizeWord(plant.status || '')}</div>`,
            `<div class="text-muted">${plant.country || 'Unknown'}</div>`
        ]
    );
}

/**
 * Build a muted line listing the countries a cell's area overlaps.
 * Single country renders as "France"; several as "France · Spain · Andorra".
 * @param {string[]} names - ordered country names (primary first)
 */
export function buildCountryLine(names) {
    if (!Array.isArray(names) || names.length === 0) return '';
    return `<div class="text-muted">${names.join(' · ')}</div>`;
}
