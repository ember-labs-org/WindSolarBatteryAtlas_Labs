// This module runs in two roles. As the LCOE worker it holds the full grid and
// answers searches. Started with ?load (by the LCOE worker for the grid, or by
// the page for one summary slice), it only fetches and decodes and hands the
// result back: decoding needs parquet-wasm, whose memory (~140 MB) never
// shrinks, so it runs in a worker of its own that is closed once done.
import {
    addonPassTarget, addonPassBudget, newTargetState, newBudgetState, addonRowFields,
    denseWindSplit, blendedDegradation3, addonTransferList, addonPairColumns,
    techOffMask, denseTechMask, excludedConfigs, TECH_OFFSHORE
} from '../addon.js';

const LOADER = new URL(import.meta.url).searchParams.has('load');

const STATE = {
    // Every configuration for every location, as flat typed arrays. 4,465
    // locations x 3,216 configurations is 14 million capacity factors: 57 MB as
    // a Float32Array. The worker fetches and decodes it itself, so the main
    // thread never holds or copies it.
    matrix: null,
    // Per-location WACC, capex, diesel and gas lookups, sent once per change.
    lookups: {},
    // The sparse add-on builds (T058, addon.js), as CSRs over the matrix's
    // location order; null when there is no add-on (or ?addon=0).
    addon: null
};

const BASE_LOAD_MW = 1000;
const DIESEL_THERMAL_KWH_PER_LITER = 10.0;
// Global unsubsidized diesel floor (crude + refining + delivery, pre-tax). Must match constants.js.
const DIESEL_PRICE_FLOOR_USD_PER_LITER = 0.80;
// 1 MWh_thermal = 3.412 MMBtu — used to convert wholesale gas ($/MMBtu) to OCGT fuel cost. Must match constants.js.
const MMBTU_PER_MWH = 3.412;

function capitalRecoveryFactor(rate, years) {
    if (!Number.isFinite(rate) || !Number.isFinite(years) || years <= 0) {
        return 0;
    }
    if (rate === 0) {
        return 1 / years;
    }
    const pow = Math.pow(1 + rate, years);
    const denominator = pow - 1;
    return denominator === 0 ? 0 : (rate * pow) / denominator;
}

// Level-equivalent annual multiplier for a stream growing at `growth`/yr over
// `years`, discounted at `rate`. Returns 1 when growth === 0. Used with
// growth = -degradation for an energy denominator. Mirrors utils.js.
function levelizedGrowthMultiplier(growth, rate, years) {
    if (!(years > 0)) return 0;
    const crf = capitalRecoveryFactor(rate, years);
    const ratio = (1 + growth) / (1 + rate);
    let pv;
    if (Math.abs(ratio - 1) < 1e-12) {
        pv = years / (1 + rate);
    } else {
        pv = (1 / (1 + growth)) * ratio * (1 - Math.pow(ratio, years)) / (1 - ratio);
    }
    return pv * crf;
}

// Degradation factor on the energy of a solar + wind build (T013). Each source
// loses output at its own rate, so the factor on their combined energy is the
// average of the two factors weighted by each source's share of that energy:
// its capacity times the location's capacity factor for 1 GW of it alone.
// Where those capacity factors are unknown, capacity shares stand in.
// Identical in app.js.
function blendedDegradation(solarKw, windKw, solarCf, windCf, solarMult, windMult) {
    let s = solarKw * solarCf;
    let w = windKw * windCf;
    if (!(s + w > 0)) { s = solarKw; w = windKw; }
    return (s * solarMult + w * windMult) / (s + w);
}

function getLocalCapex(localCapexByLocation, locationId) {
    if (!localCapexByLocation) return null;
    return localCapexByLocation[String(locationId)] || localCapexByLocation[locationId] || null;
}

function getLocalWacc(waccByLocation, locationId) {
    if (!waccByLocation) return null;
    const value = waccByLocation[String(locationId)] ?? waccByLocation[locationId];
    return Number.isFinite(value) ? value : null;
}

function getLocalWindWacc(windWaccByLocation, locationId) {
    if (!windWaccByLocation) return null;
    return windWaccByLocation[String(locationId)] || windWaccByLocation[locationId] || null;
}

function getDieselInfo(dieselByLocation, locationId) {
    if (!dieselByLocation) return null;
    return dieselByLocation[String(locationId)] || dieselByLocation[locationId] || null;
}

function getGasInfo(gasByLocation, locationId) {
    if (!gasByLocation) return null;
    return gasByLocation[String(locationId)] || gasByLocation[locationId] || null;
}

function clampCf(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function computeEffectiveDieselPriceUsdPerLiter(dieselInfo, params) {
    if (params?.dieselPriceMode === 'global') {
        const globalPrice = Number.isFinite(params?.dieselPrice) ? params.dieselPrice : null;
        return {
            rawPrice: globalPrice,
            effectivePrice: globalPrice
        };
    }
    const rawPrice = Number.isFinite(dieselInfo?.rawPrice ?? dieselInfo?.price)
        ? (dieselInfo?.rawPrice ?? dieselInfo?.price)
        : null;
    const effectivePrice = Number.isFinite(rawPrice)
        ? Math.max(rawPrice, DIESEL_PRICE_FLOOR_USD_PER_LITER)
        : null;
    return {
        rawPrice,
        effectivePrice
    };
}

function computeDieselFuelCostPerMwh(dieselPriceUsdPerLiter, params) {
    const efficiency = Number.isFinite(params.dieselEfficiency) && params.dieselEfficiency > 0
        ? params.dieselEfficiency
        : null;
    if (!Number.isFinite(dieselPriceUsdPerLiter) || !efficiency) {
        return Infinity;
    }
    return (dieselPriceUsdPerLiter * 1000) / (efficiency * DIESEL_THERMAL_KWH_PER_LITER);
}

// Resolve the wholesale gas price ($/MMBtu). Local mode uses the per-region IGU
// price; global mode applies a single user value. Availability is always gated by
// the per-region data (gasInfo.available) — regions with no gas market fall back to
// diesel even in global mode.
function computeEffectiveGasPriceUsdPerMmbtu(gasInfo, params) {
    if (params?.gasPriceMode === 'global') {
        const globalPrice = Number.isFinite(params?.gasPrice) ? params.gasPrice : null;
        return { rawPrice: globalPrice, effectivePrice: globalPrice };
    }
    const rawPrice = Number.isFinite(gasInfo?.rawPrice ?? gasInfo?.price)
        ? (gasInfo?.rawPrice ?? gasInfo?.price)
        : null;
    return { rawPrice, effectivePrice: rawPrice };
}

function computeGasFuelCostPerMwh(gasPriceUsdPerMmbtu, params) {
    const efficiency = Number.isFinite(params.gasEfficiency) && params.gasEfficiency > 0
        ? params.gasEfficiency
        : null;
    if (!Number.isFinite(gasPriceUsdPerMmbtu) || !efficiency) {
        return Infinity;
    }
    return (gasPriceUsdPerMmbtu * MMBTU_PER_MWH) / efficiency;
}

// Per-location constants. All rows in a location share these.
// `unitCf` holds the location's capacity factors for 1 GW of solar, onshore
// wind and offshore wind alone (matrixUnitCf), which weight degradation.
function precomputeLcoePerLocation(params, costMultipliers, localWacc, localCapex, dieselInfo, gasInfo, localWindWacc, unitCf) {
    const resolvedWacc = Number.isFinite(localWacc) ? localWacc : params.wacc;

    const ilr = Number.isFinite(params.ilr) && params.ilr > 0 ? params.ilr : 1;
    const solarCapexBase = Number.isFinite(localCapex?.solar)
        ? localCapex.solar
        : params.solarCapex * (costMultipliers?.solar || 1);
    const batteryCapexBase = Number.isFinite(localCapex?.battery)
        ? localCapex.battery
        : params.batteryCapex * (costMultipliers?.battery || 1);
    const solarCapexPerKw = solarCapexBase / ilr;

    // Wind. Onshore and offshore are priced separately: they differ by roughly
    // a factor of three in capex, and offshore carries a higher cost of capital.
    const windOnCapexBase = Number.isFinite(localCapex?.windOn)
        ? localCapex.windOn
        : params.windCapex * (costMultipliers?.wind || 1);
    const windOffCapexBase = Number.isFinite(localCapex?.windOff)
        ? localCapex.windOff
        : params.windOffCapex * (costMultipliers?.windOff || 1);
    // Local capex mode sends wind O&M per cell in $/kW/yr; the engine takes O&M
    // as a share of capex. Same rule as the main thread.
    const windOpexPct = Number.isFinite(localCapex?.windOn) && Number.isFinite(localCapex?.windOnOm)
        ? localCapex.windOnOm / windOnCapexBase
        : params.windOpexPct;
    const windOffOpexPct = Number.isFinite(localCapex?.windOff) && Number.isFinite(localCapex?.windOffOm)
        ? localCapex.windOffOm / windOffCapexBase
        : params.windOffOpexPct;
    // Wind cost of capital follows the WACC setting: local mode sends the cell's
    // onshore and offshore figures; otherwise the WACC plus the premiums. Same
    // rule as the main thread (app.js precomputeLcoePerLocation).
    const windOnWacc = Number.isFinite(localWindWacc?.on)
        ? localWindWacc.on
        : resolvedWacc + (params.windWaccPremium || 0);
    const windOffWacc = Number.isFinite(localWindWacc?.off)
        ? localWindWacc.off
        : resolvedWacc + (params.windOffWaccPremium || 0);

    const solarCrf = capitalRecoveryFactor(resolvedWacc, params.solarLife);
    const batteryCrf = capitalRecoveryFactor(resolvedWacc, params.batteryLife);
    const windOnCrf = capitalRecoveryFactor(windOnWacc, params.windLife);
    const windOffCrf = capitalRecoveryFactor(windOffWacc, params.windOffLife);
    // Turbine output degradation, like PV's, discounted at the wind rate over the wind life.
    const windOnDegradationMult = levelizedGrowthMultiplier(-(params.windDegradationPct || 0), windOnWacc, params.windLife);
    const windOffDegradationMult = levelizedGrowthMultiplier(-(params.windOffDegradationPct || 0), windOffWacc, params.windOffLife);

    // PV degradation, as a level-equivalent factor on the energy denominator.
    const energyDegradationMult = levelizedGrowthMultiplier(-(params.solarDegradationPct || 0), resolvedWacc, params.solarLife);

    // "Backup" is on/off; when on, each row picks the cheaper of diesel vs gas (OCGT).
    const includeDieselBackup = Boolean(params.includeDieselBackup);
    let dieselPricing = null;
    let dieselFuelCostPerMwh = 0;
    let dieselCapexAnnual = 0;
    let dieselContext = null;
    let gasAvailable = false;
    let gasPricing = null;
    let gasFuelCostPerMwh = Infinity;
    let gasCapexAnnual = 0;
    let gasContext = null;
    if (includeDieselBackup) {
        dieselPricing = computeEffectiveDieselPriceUsdPerLiter(dieselInfo, params);
        dieselFuelCostPerMwh = computeDieselFuelCostPerMwh(dieselPricing.effectivePrice, params);
        const dieselCapex = BASE_LOAD_MW * 1000 * params.dieselCapex;
        const dieselCrf = capitalRecoveryFactor(resolvedWacc, params.dieselLife);
        dieselCapexAnnual = dieselCapex * dieselCrf;
        dieselContext = {
            sourceYear: dieselInfo?.sourceYear ?? null,
            sourceType: dieselInfo?.sourceType ?? null,
            sourceDistanceKm: dieselInfo?.sourceDistanceKm ?? null,
            sourceIso3: dieselInfo?.sourceIso3 ?? null,
            sourceCountry: dieselInfo?.sourceCountry ?? null,
            sourceSeriesName: dieselInfo?.sourceSeriesName ?? null
        };

        // Gas (OCGT) is only a candidate where a wholesale price exists for the region.
        gasAvailable = Boolean(gasInfo?.available);
        if (gasAvailable) {
            gasPricing = computeEffectiveGasPriceUsdPerMmbtu(gasInfo, params);
            gasFuelCostPerMwh = computeGasFuelCostPerMwh(gasPricing.effectivePrice, params);
            const gasCapex = BASE_LOAD_MW * 1000 * params.gasCapex;
            const gasCrf = capitalRecoveryFactor(resolvedWacc, params.gasLife);
            gasCapexAnnual = gasCapex * gasCrf;
            gasContext = {
                priceUsdPerMmbtu: gasPricing.effectivePrice,
                sourceIso3: gasInfo?.sourceIso3 ?? null,
                sourceCountry: gasInfo?.sourceCountry ?? null,
                sourceDistanceKm: gasInfo?.sourceDistanceKm ?? null
            };
        }
    }

    return {
        includeDieselBackup,
        solarCapexPerKw,
        batteryCapexBase,
        windOnCapexBase,
        windOffCapexBase,
        windOnCrf,
        windOffCrf,
        windOpexPct,
        windOffOpexPct,
        solarCrf,
        batteryCrf,
        solarOpexPct: params.solarOpexPct,
        batteryOpexPct: params.batteryOpexPct,
        energyDegradationMult,
        windOnDegradationMult,
        windOffDegradationMult,
        solarUnitCf: unitCf ? unitCf.solar : NaN,
        windOnUnitCf: unitCf ? unitCf.on : NaN,
        windOffUnitCf: unitCf ? unitCf.off : NaN,
        dieselPricing,
        dieselFuelCostPerMwh,
        dieselCapexAnnual,
        dieselContext,
        gasAvailable,
        gasPricing,
        gasFuelCostPerMwh,
        gasCapexAnnual,
        gasContext
    };
}

function computeLcoeMetrics(row, pre) {
    const solarKw = Number.isFinite(row._solarKw) ? row._solarKw : row.solar_gw * 1_000_000;
    const batteryKwh = Number.isFinite(row._batteryKwh) ? row._batteryKwh : row.batt_gwh * 1_000_000;
    const solarShareCf = clampCf(row.annual_cf);
    const includeDieselBackup = pre.includeDieselBackup;
    const firmCf = includeDieselBackup ? 1 : solarShareCf;
    // Set below with backup on: the backup's energy over the full load.
    let backupShareCf = 0;

    const windKw = Number.isFinite(row._windKw) ? row._windKw : (row.wind_gw || 0) * 1_000_000;
    const offshore = row.wind_surface === 'off';
    // A combined onshore + offshore add-on build (T058): never a configs.json row.
    const both = row.wind_surface === 'both';

    const solarCapex = pre.solarCapexPerKw * solarKw;
    const batteryCapex = pre.batteryCapexBase * batteryKwh;
    let windAnnual, windOpex, windOnKw = 0, windOffKw = 0;
    if (both) {
        windOnKw = Number.isFinite(row._windOnKw) ? row._windOnKw : (row.wind_on_gw || 0) * 1_000_000;
        windOffKw = Number.isFinite(row._windOffKw) ? row._windOffKw : (row.wind_off_gw || 0) * 1_000_000;
        const onCapex = pre.windOnCapexBase * windOnKw;
        const offCapex = pre.windOffCapexBase * windOffKw;
        windAnnual = onCapex * pre.windOnCrf + offCapex * pre.windOffCrf;
        windOpex = onCapex * pre.windOpexPct + offCapex * pre.windOffOpexPct;
    } else {
        const windCapex = (offshore ? pre.windOffCapexBase : pre.windOnCapexBase) * windKw;
        windAnnual = windCapex * (offshore ? pre.windOffCrf : pre.windOnCrf);
        windOpex = windCapex * (offshore ? pre.windOffOpexPct : pre.windOpexPct);
    }
    const solarAnnual = solarCapex * pre.solarCrf;
    const batteryAnnual = batteryCapex * pre.batteryCrf;
    const solarOpex = solarCapex * pre.solarOpexPct;
    const batteryOpex = batteryCapex * pre.batteryOpexPct;

    let annualCost = solarAnnual + batteryAnnual + windAnnual + solarOpex + batteryOpex + windOpex;
    let annualEnergyMwh = Number.isFinite(row._annualEnergyMwh)
        ? row._annualEnergyMwh
        : solarShareCf * 8760 * BASE_LOAD_MW;
    // Degradation reduces the renewable energy denominator, weighted by each
    // source's share of the energy (blendedDegradation).
    if (both) {
        annualEnergyMwh *= blendedDegradation3(solarKw, windOnKw, windOffKw,
            pre.solarUnitCf, pre.windOnUnitCf, pre.windOffUnitCf,
            pre.energyDegradationMult, pre.windOnDegradationMult, pre.windOffDegradationMult);
    } else if (windKw > 0) {
        annualEnergyMwh *= blendedDegradation(solarKw, windKw,
            pre.solarUnitCf, offshore ? pre.windOffUnitCf : pre.windOnUnitCf,
            pre.energyDegradationMult, offshore ? pre.windOffDegradationMult : pre.windOnDegradationMult);
    } else {
        annualEnergyMwh *= pre.energyDegradationMult;
    }

    // Backup display/output fields. When backup is on we price BOTH diesel and gas
    // (where available) and keep the cheaper. diesel_* fields stay populated for the
    // tooltip; gas_* fields populate where a wholesale gas price exists.
    let backupFuel = null;
    let backupLcoeAdder = 0;
    let backupEnergyMwh = 0;
    let dieselPriceUsdPerLiter = null;
    let dieselSourceYear = null;
    let dieselSourceType = null;
    let dieselSourceDistanceKm = null;
    let dieselSourceCountryIso3 = null;
    let dieselSourceCountryName = null;
    let dieselSourceSeriesName = null;
    let gasAvailable = false;
    let gasPriceUsdPerMmbtu = null;
    let gasSourceCountryIso3 = null;
    let gasSourceCountryName = null;
    let gasSourceDistanceKm = null;

    const makeResult = (lcoe) => ({
        lcoe,
        annual_energy_mwh: annualEnergyMwh,
        firm_cf: firmCf,
        solar_share_cf: solarShareCf,
        diesel_share_cf: backupShareCf,
        backup_share_cf: backupShareCf,
        backup_fuel: backupFuel,
        backup_lcoe_adder: backupLcoeAdder,
        backup_energy_mwh: backupEnergyMwh,
        // diesel_lcoe_adder/diesel_energy_mwh mirror the chosen backup so existing
        // consumers (charts that read diesel_lcoe_adder) reflect the cheaper fuel.
        diesel_lcoe_adder: backupLcoeAdder,
        diesel_energy_mwh: backupEnergyMwh,
        diesel_price_usd_per_liter: dieselPriceUsdPerLiter,
        diesel_source_year: dieselSourceYear,
        diesel_source_type: dieselSourceType,
        diesel_source_distance_km: dieselSourceDistanceKm,
        diesel_source_country_iso3: dieselSourceCountryIso3,
        diesel_source_country_name: dieselSourceCountryName,
        diesel_source_series_name: dieselSourceSeriesName,
        gas_available: gasAvailable,
        gas_price_usd_per_mmbtu: gasPriceUsdPerMmbtu,
        gas_source_country_iso3: gasSourceCountryIso3,
        gas_source_country_name: gasSourceCountryName,
        gas_source_distance_km: gasSourceDistanceKm,
        includeDieselBackup
    });

    if (includeDieselBackup) {
        // The renewables deliver their degraded energy (annualEnergyMwh so far);
        // the backup serves the rest of the full load, which is the denominator.
        const fullLoadMwh = 8760 * BASE_LOAD_MW;
        backupEnergyMwh = Math.max(0, fullLoadMwh - annualEnergyMwh);
        backupShareCf = backupEnergyMwh / fullLoadMwh;
        annualEnergyMwh = fullLoadMwh;

        // Diesel candidate (available wherever a diesel price resolves).
        const dc = pre.dieselContext;
        dieselPriceUsdPerLiter = pre.dieselPricing ? pre.dieselPricing.effectivePrice : null;
        if (dc) {
            dieselSourceYear = dc.sourceYear;
            dieselSourceType = dc.sourceType;
            dieselSourceDistanceKm = dc.sourceDistanceKm;
            dieselSourceCountryIso3 = dc.sourceIso3;
            dieselSourceCountryName = dc.sourceCountry;
            dieselSourceSeriesName = dc.sourceSeriesName;
        }
        const dieselTotalAnnual = Number.isFinite(pre.dieselFuelCostPerMwh)
            ? pre.dieselCapexAnnual + backupEnergyMwh * pre.dieselFuelCostPerMwh
            : Infinity;

        // Gas (OCGT) candidate — only where a wholesale price exists for the region.
        gasAvailable = Boolean(pre.gasAvailable);
        let gasTotalAnnual = Infinity;
        if (gasAvailable && Number.isFinite(pre.gasFuelCostPerMwh)) {
            gasTotalAnnual = pre.gasCapexAnnual + backupEnergyMwh * pre.gasFuelCostPerMwh;
            const gc = pre.gasContext;
            if (gc) {
                gasPriceUsdPerMmbtu = gc.priceUsdPerMmbtu;
                gasSourceCountryIso3 = gc.sourceIso3;
                gasSourceCountryName = gc.sourceCountry;
                gasSourceDistanceKm = gc.sourceDistanceKm;
            }
        }

        // Pick the cheaper backup fuel for this configuration.
        let backupTotalAnnual;
        if (gasTotalAnnual < dieselTotalAnnual) {
            backupFuel = 'gas';
            backupTotalAnnual = gasTotalAnnual;
        } else {
            backupFuel = 'diesel';
            backupTotalAnnual = dieselTotalAnnual;
        }

        if (!Number.isFinite(backupTotalAnnual)) {
            backupLcoeAdder = Infinity;
            return makeResult(Infinity);
        }

        annualCost += backupTotalAnnual;
        backupLcoeAdder = annualEnergyMwh > 0 ? backupTotalAnnual / annualEnergyMwh : Infinity;
    }

    if (!Number.isFinite(annualEnergyMwh) || annualEnergyMwh <= 0) {
        return makeResult(Infinity);
    }

    return makeResult(annualCost / annualEnergyMwh);
}

function sortByLocationId(results) {
    results.sort((a, b) => {
        const aId = Number(a.location_id);
        const bId = Number(b.location_id);
        if (Number.isFinite(aId) && Number.isFinite(bId)) {
            return aId - bId;
        }
        return String(a.location_id).localeCompare(String(b.location_id));
    });
    return results;
}

// ---------------------------------------------------------------------------
// Full-grid (matrix) search.
//
// 16 million combinations per search, so the inner loop works on scalars and
// preallocated typed arrays only: it computes each combination's LCOE into a
// per-location buffer and keeps the index of each running best. The full result
// object is built only for each location's winner, by computeLcoeMetrics(), so
// every field is produced by the original code. The scalar LCOE below performs
// the same floating-point operations in the same order as computeLcoeMetrics(),
// so the comparisons, and therefore the winners and tie-breaks, are unchanged.
// ---------------------------------------------------------------------------

// Index each config's solar, battery and (wind level, surface) so per-location
// capital and O&M terms can be computed once per distinct level, not per config.
function buildMatrixLevels(m) {
    const { solarGw, windGw, battGwh, surfaceOff, nCfg } = m;
    const solarIdx = new Uint16Array(nCfg);
    const battIdx = new Uint16Array(nCfg);
    const windIdx = new Uint16Array(nCfg);
    const solarKwLevels = [], battKwhLevels = [], windKwLevels = [], windOffLevels = [];
    const solarMap = new Map(), battMap = new Map(), windMap = new Map();
    for (let ci = 0; ci < nCfg; ci++) {
        const solarKw = solarGw[ci] * 1_000_000;
        const batteryKwh = battGwh[ci] * 1_000_000;
        const windKw = windGw[ci] * 1_000_000;
        const off = surfaceOff[ci] ? 1 : 0;
        let k = solarMap.get(solarGw[ci]);
        if (k === undefined) { k = solarKwLevels.length; solarMap.set(solarGw[ci], k); solarKwLevels.push(solarKw); }
        solarIdx[ci] = k;
        k = battMap.get(battGwh[ci]);
        if (k === undefined) { k = battKwhLevels.length; battMap.set(battGwh[ci], k); battKwhLevels.push(batteryKwh); }
        battIdx[ci] = k;
        const wKey = windGw[ci] * 2 + off;
        k = windMap.get(wKey);
        if (k === undefined) { k = windKwLevels.length; windMap.set(wKey, k); windKwLevels.push(windKw); windOffLevels.push(off); }
        windIdx[ci] = k;
    }
    m.solarIdx = solarIdx;
    m.battIdx = battIdx;
    m.windIdx = windIdx;
    m.solarKwLevels = Float64Array.from(solarKwLevels);
    m.battKwhLevels = Float64Array.from(battKwhLevels);
    m.windKwLevels = Float64Array.from(windKwLevels);
    m.windOffLevels = Uint8Array.from(windOffLevels);
    // Each config's (solar level, wind level) pair, which fixes its degradation factor.
    const nW = windKwLevels.length;
    m.pairIdx = new Uint16Array(nCfg);
    for (let ci = 0; ci < nCfg; ci++) m.pairIdx[ci] = solarIdx[ci] * nW + windIdx[ci];
    m.unitCfg = unitConfigIndices(m);
    // Offshore configs, for onshore-only searches (see dropOffshore).
    const offshore = [];
    for (let ci = 0; ci < nCfg; ci++) if (surfaceOff[ci]) offshore.push(ci);
    m.offshoreCfg = Int32Array.from(offshore);
    // Each config's technologies, once (T074): the tech filter skips by mask.
    denseTechMask(m);
    // Per-location scratch, reused for every location and every search.
    m.solarAnnualT = new Float64Array(solarKwLevels.length);
    m.solarOpexT = new Float64Array(solarKwLevels.length);
    m.battAnnualT = new Float64Array(battKwhLevels.length);
    m.battOpexT = new Float64Array(battKwhLevels.length);
    m.windAnnualT = new Float64Array(windKwLevels.length);
    m.windOpexT = new Float64Array(windKwLevels.length);
    m.degrT = new Float64Array(solarKwLevels.length * nW);
    m.lcoeBuf = new Float64Array(nCfg);
}

/**
 * Config indices of 1 GW of solar, onshore wind and offshore wind alone, no
 * battery (-1 where the grid lacks one). Their capacity factors at a location
 * are what 1 GW of each source delivers there. Identical in app.js.
 */
function unitConfigIndices(m) {
    const { solarGw, windGw, battGwh, surfaceOff, nCfg } = m;
    const u = { solar: -1, on: -1, off: -1 };
    for (let ci = 0; ci < nCfg; ci++) {
        if (battGwh[ci] !== 0) continue;
        if (solarGw[ci] === 1 && windGw[ci] === 0 && u.solar < 0) u.solar = ci;
        if (solarGw[ci] === 0 && windGw[ci] === 1) {
            if (surfaceOff[ci]) { if (u.off < 0) u.off = ci; } else if (u.on < 0) u.on = ci;
        }
    }
    return u;
}

/** The location's capacity factors for 1 GW of each source alone (NaN if not in the grid). */
function matrixUnitCf(m, li) {
    const u = m.unitCfg;
    const base = li * m.nCfg;
    return {
        solar: u.solar >= 0 ? m.cf[base + u.solar] : NaN,
        on: u.on >= 0 ? m.cf[base + u.on] : NaN,
        off: u.off >= 0 ? m.cf[base + u.off] : NaN
    };
}

/**
 * LCOE of every config at matrix location `li` into m.lcoeBuf; NaN marks a
 * config to skip (unsimulated, dead or non-finite LCOE). Mirrors
 * computeLcoeMetrics() operation for operation.
 */
function fillLocationLcoe(m, li, pre) {
    const { cf, nCfg, solarIdx, battIdx, windIdx, pairIdx, lcoeBuf } = m;
    const sA = m.solarAnnualT, sO = m.solarOpexT;
    const bA = m.battAnnualT, bO = m.battOpexT;
    const wA = m.windAnnualT, wO = m.windOpexT;

    // Capital and O&M by capacity level: identical expressions to computeLcoeMetrics.
    for (let k = 0; k < sA.length; k++) {
        const solarCapex = pre.solarCapexPerKw * m.solarKwLevels[k];
        sA[k] = solarCapex * pre.solarCrf;
        sO[k] = solarCapex * pre.solarOpexPct;
    }
    for (let k = 0; k < bA.length; k++) {
        const batteryCapex = pre.batteryCapexBase * m.battKwhLevels[k];
        bA[k] = batteryCapex * pre.batteryCrf;
        bO[k] = batteryCapex * pre.batteryOpexPct;
    }
    for (let k = 0; k < wA.length; k++) {
        const offshore = m.windOffLevels[k] === 1;
        const windCapex = (offshore ? pre.windOffCapexBase : pre.windOnCapexBase) * m.windKwLevels[k];
        wA[k] = windCapex * (offshore ? pre.windOffCrf : pre.windOnCrf);
        wO[k] = windCapex * (offshore ? pre.windOffOpexPct : pre.windOpexPct);
    }

    // Degradation factor by (solar level, wind level): identical calls to computeLcoeMetrics.
    const dT = m.degrT;
    const nW = wA.length;
    const degr = pre.energyDegradationMult;
    for (let si = 0; si < sA.length; si++) {
        for (let wi = 0; wi < nW; wi++) {
            const windKw = m.windKwLevels[wi];
            const offshore = m.windOffLevels[wi] === 1;
            dT[si * nW + wi] = windKw > 0
                ? blendedDegradation(m.solarKwLevels[si], windKw,
                    pre.solarUnitCf, offshore ? pre.windOffUnitCf : pre.windOnUnitCf,
                    degr, offshore ? pre.windOffDegradationMult : pre.windOnDegradationMult)
                : degr;
        }
    }
    const base = li * nCfg;

    if (!pre.includeDieselBackup) {
        for (let ci = 0; ci < nCfg; ci++) {
            const annualCf = cf[base + ci];
            if (!(annualCf > 0)) { lcoeBuf[ci] = NaN; continue; }
            const si = solarIdx[ci], bi = battIdx[ci], wi = windIdx[ci];
            const annualCost = sA[si] + bA[bi] + wA[wi] + sO[si] + bO[bi] + wO[wi];
            let annualEnergyMwh = annualCf * 8760 * BASE_LOAD_MW;
            annualEnergyMwh *= dT[pairIdx[ci]];
            if (!Number.isFinite(annualEnergyMwh) || annualEnergyMwh <= 0) { lcoeBuf[ci] = NaN; continue; }
            const lcoe = annualCost / annualEnergyMwh;
            lcoeBuf[ci] = Number.isFinite(lcoe) ? lcoe : NaN;
        }
        return;
    }

    // Backup on: the energy denominator is the full baseload, and each config
    // takes the cheaper of diesel and gas for the shortfall: the full load less
    // the renewables' degraded energy (as computeLcoeMetrics).
    const annualEnergyMwh = 8760 * BASE_LOAD_MW;
    const dieselFinite = Number.isFinite(pre.dieselFuelCostPerMwh);
    const dieselCapexAnnual = pre.dieselCapexAnnual;
    const dieselFuelCostPerMwh = pre.dieselFuelCostPerMwh;
    const gasUsable = Boolean(pre.gasAvailable) && Number.isFinite(pre.gasFuelCostPerMwh);
    const gasCapexAnnual = pre.gasCapexAnnual;
    const gasFuelCostPerMwh = pre.gasFuelCostPerMwh;
    for (let ci = 0; ci < nCfg; ci++) {
        const annualCf = cf[base + ci];
        if (!(annualCf > 0)) { lcoeBuf[ci] = NaN; continue; }
        const si = solarIdx[ci], bi = battIdx[ci], wi = windIdx[ci];
        let annualCost = sA[si] + bA[bi] + wA[wi] + sO[si] + bO[bi] + wO[wi];
        let renewableMwh = annualCf * 8760 * BASE_LOAD_MW;
        renewableMwh *= dT[pairIdx[ci]];
        const backupEnergyMwh = Math.max(0, annualEnergyMwh - renewableMwh);
        const dieselTotalAnnual = dieselFinite
            ? dieselCapexAnnual + backupEnergyMwh * dieselFuelCostPerMwh
            : Infinity;
        const gasTotalAnnual = gasUsable
            ? gasCapexAnnual + backupEnergyMwh * gasFuelCostPerMwh
            : Infinity;
        const backupTotalAnnual = gasTotalAnnual < dieselTotalAnnual ? gasTotalAnnual : dieselTotalAnnual;
        if (!Number.isFinite(backupTotalAnnual)) { lcoeBuf[ci] = NaN; continue; }
        annualCost += backupTotalAnnual;
        const lcoe = annualCost / annualEnergyMwh;
        lcoeBuf[ci] = Number.isFinite(lcoe) ? lcoe : NaN;
    }
}

/**
 * 'Include offshore wind' unticked: skip every offshore config, exactly as an unpriced one
 * is skipped. Same rule as the main-thread search (computeBestLcoeFromMatrix):
 * params.includeOffshore === false excludes configs with surfaceOff set.
 */
function dropOffshore(m) {
    const { offshoreCfg, lcoeBuf } = m;
    for (let k = 0; k < offshoreCfg.length; k++) lcoeBuf[offshoreCfg[k]] = NaN;
}

/**
 * The technology filter (T074): skip every config that uses a switched-off
 * technology, as an unpriced one is skipped. Offshore alone is dropOffshore's
 * rule; any other mask takes the cached config list of addon.js excludedConfigs.
 */
function dropExcluded(m, offMask) {
    if (!offMask) return;
    if (offMask === TECH_OFFSHORE) { dropOffshore(m); return; }
    const list = excludedConfigs(m, offMask);
    const { lcoeBuf } = m;
    for (let k = 0; k < list.length; k++) lcoeBuf[list[k]] = NaN;
}

function locationPre(payload, li) {
    const { params, costMultipliers } = payload;
    const { waccByLocation, windWaccByLocation, localCapexByLocation, dieselByLocation, gasByLocation } = STATE.lookups;
    const locationId = STATE.matrix.locationIds[li];
    return precomputeLcoePerLocation(
        params, costMultipliers,
        getLocalWacc(waccByLocation, locationId),
        getLocalCapex(localCapexByLocation, locationId),
        getDieselInfo(dieselByLocation, locationId),
        getGasInfo(gasByLocation, locationId),
        getLocalWindWacc(windWaccByLocation, locationId),
        matrixUnitCf(STATE.matrix, li)
    );
}

// The result row for one matrix combination, built exactly as the per-combination
// loop used to build it: { ...row, ...computeLcoeMetrics(row, pre) }.
function matrixEntry(m, li, ci, pre) {
    const solarGw = m.solarGw[ci], windGw = m.windGw[ci], battGwh = m.battGwh[ci];
    const annualCf = m.cf[li * m.nCfg + ci];
    const row = {
        location_id: m.locationIds[li],
        solar_gw: solarGw,
        wind_gw: windGw,
        batt_gwh: battGwh,
        annual_cf: annualCf,
        wind_surface: m.surfaceOff[ci] ? 'off' : 'on',
        _solarKw: solarGw * 1_000_000,
        _windKw: windGw * 1_000_000,
        _batteryKwh: battGwh * 1_000_000,
        _annualEnergyMwh: annualCf * 8760 * BASE_LOAD_MW
    };
    return { ...row, ...computeLcoeMetrics(row, pre) };
}

// The result row for an add-on candidate (addon.js), with matrixEntry's keys in
// matrixEntry's order. Combined builds are priced from their two wind capacities.
function addonEntry(m, li, cand, pre) {
    const f = addonRowFields(cand);
    const row = {
        location_id: m.locationIds[li],
        solar_gw: f.solar_gw,
        wind_gw: f.wind_gw,
        batt_gwh: f.batt_gwh,
        annual_cf: f.annual_cf,
        wind_surface: f.wind_surface,
        _solarKw: f._solarKw,
        _windKw: f._windKw,
        _batteryKwh: f._batteryKwh,
        _annualEnergyMwh: f._annualEnergyMwh
    };
    const metrics = computeLcoeMetrics({ ...row, _windOnKw: f._windOnKw, _windOffKw: f._windOffKw }, pre);
    return { entry: { ...row, ...metrics }, fields: f };
}

// With the add-on loaded every result row carries the same extra keys, after
// today's, so the answer still crosses as columns (encodeRows needs one shape).
function addonTail(chosen, fields) {
    if (fields) {
        chosen.wind_on_gw = fields.wind_on_gw;
        chosen.wind_off_gw = fields.wind_off_gw;
        chosen.addon = fields.addon;
        chosen.interpolated = fields.interpolated;
        chosen.curtailed_share = fields.curtailed_share;
    } else {
        const split = denseWindSplit(chosen.wind_gw, chosen.wind_surface === 'off');
        chosen.wind_on_gw = split.on;
        chosen.wind_off_gw = split.off;
        chosen.addon = null;
        chosen.interpolated = false;
        chosen.curtailed_share = null;
    }
}

/**
 * Least-cost build per location, searching the full three-axis grid.
 * Ties: first config in config order wins (strict comparisons throughout).
 */
function computeBestLcoeMatrix(payload) {
    // T067 (T065-V-2): CFs are float32 (stored to 4 dp), so compare against the
    // float32 target: a build exactly at 90% (0.89999998) meets a 90% target.
    // The main thread does the same (computeBestLcoeFromMatrix). Rows keep the target as given.
    const { targetCf } = payload;
    const tieCf = Math.fround(targetCf);
    const includeOffshore = payload.params?.includeOffshore !== false;
    const offMask = techOffMask(payload.params);
    const m = STATE.matrix;
    const results = [];
    const { cf, locationIds, windGw, nCfg, lcoeBuf } = m;

    for (let li = 0; li < locationIds.length; li++) {
        const pre = locationPre(payload, li);
        fillLocationLcoe(m, li, pre);
        dropExcluded(m, offMask);

        // Indices (-1 = none) and the keys they are compared on.
        let best = -1, bestLcoe = 0;
        let bestNoWind = -1, bestNoWindLcoe = 0;
        // Most firm energy, then cheapest. Also the "max config" reported per location.
        let bestFb = -1, bestFbCf = 0, bestFbLcoe = 0;
        let bestFbNoWind = -1, bestFbNoWindCf = 0, bestFbNoWindLcoe = 0;
        const base = li * nCfg;

        for (let ci = 0; ci < nCfg; ci++) {
            const lcoe = lcoeBuf[ci];
            if (lcoe !== lcoe) continue;                 // NaN: skipped config
            const annualCf = cf[base + ci];
            const noWind = windGw[ci] === 0;

            if (annualCf >= tieCf) {
                if (best < 0 || lcoe < bestLcoe) { best = ci; bestLcoe = lcoe; }
                if (noWind && (bestNoWind < 0 || lcoe < bestNoWindLcoe)) { bestNoWind = ci; bestNoWindLcoe = lcoe; }
            }
            if (bestFb < 0 || annualCf > bestFbCf || (annualCf === bestFbCf && lcoe < bestFbLcoe)) {
                bestFb = ci; bestFbCf = annualCf; bestFbLcoe = lcoe;
            }
            if (noWind && (bestFbNoWind < 0 || annualCf > bestFbNoWindCf
                || (annualCf === bestFbNoWindCf && lcoe < bestFbNoWindLcoe))) {
                bestFbNoWind = ci; bestFbNoWindCf = annualCf; bestFbNoWindLcoe = lcoe;
            }
        }

        if (STATE.addon) {
            const row = addonTargetRow(m, li, pre, targetCf, includeOffshore, offMask, {
                best, bestLcoe, bestNoWind, bestNoWindLcoe, bestFb, bestFbCf, bestFbLcoe,
                bestFbNoWind, bestFbNoWindLcoe
            });
            if (row) results.push(row);
            continue;
        }
        if (bestFb < 0) continue;                        // nothing priced here
        const meetsTarget = best >= 0;
        const chosen = matrixEntry(m, li, meetsTarget ? best : bestFb, pre);
        chosen.targetCf = targetCf;
        chosen.meetsTarget = meetsTarget;
        // The highest-CF build is the fallback winner (same rule, same rows).
        chosen.maxConfigSolar = m.solarGw[bestFb];
        chosen.maxConfigWind = windGw[bestFb];
        chosen.maxConfigBatt = m.battGwh[bestFb];
        chosen.maxConfigLcoe = bestFbLcoe;
        const noWindIdx = bestNoWind >= 0 ? bestNoWind : bestFbNoWind;
        const noWindLcoe = bestNoWind >= 0 ? bestNoWindLcoe : bestFbNoWindLcoe;
        chosen.noWindLcoe = noWindIdx >= 0 ? noWindLcoe : null;
        chosen.noWindMeetsTarget = bestNoWind >= 0;
        chosen.windSaving = (Number.isFinite(chosen.lcoe) && noWindIdx >= 0 && Number.isFinite(noWindLcoe))
            ? noWindLcoe - chosen.lcoe : null;
        const sGw = chosen.solar_gw || 0, wGw = chosen.wind_gw || 0;
        chosen.windShare = (sGw + wGw) > 0 ? wGw / (sGw + wGw) : 0;
        chosen.windSurfaces = includeOffshore ? 'both' : 'onshore';
        results.push(chosen);
    }
    return sortByLocationId(results);
}

/**
 * One location's result with the add-on: the dense loop's bests (`d`, indices
 * and keys) continued by addonPassTarget, then the same row as without it, plus
 * the add-on keys (addonTail and the max-config split).
 */
function addonTargetRow(m, li, pre, targetCf, includeOffshore, offMask, d) {
    const st = newTargetState();
    st.hasBest = d.best >= 0; st.bestLcoe = d.bestLcoe;
    st.hasNw = d.bestNoWind >= 0; st.nwLcoe = d.bestNoWindLcoe;
    st.hasFb = d.bestFb >= 0; st.fbCf = d.bestFbCf; st.fbLcoe = d.bestFbLcoe;
    addonPassTarget(STATE.addon, li, pre, Math.fround(targetCf), includeOffshore, st, offMask);   // T067: float32 tie
    if (!st.hasFb) return null;                          // nothing priced here
    const meetsTarget = st.hasBest;
    const cand = meetsTarget ? st.best : st.fb;
    let chosen, fields = null;
    if (cand) ({ entry: chosen, fields } = addonEntry(m, li, cand, pre));
    else chosen = matrixEntry(m, li, meetsTarget ? d.best : d.bestFb, pre);
    chosen.targetCf = targetCf;
    chosen.meetsTarget = meetsTarget;
    let fbOn, fbOff, fbSurface;
    if (st.fb) {
        chosen.maxConfigSolar = st.fb.solar;
        chosen.maxConfigWind = st.fb.on + st.fb.off;
        chosen.maxConfigBatt = st.fb.batt;
        fbOn = st.fb.on; fbOff = st.fb.off; fbSurface = 'both';
    } else {
        chosen.maxConfigSolar = m.solarGw[d.bestFb];
        chosen.maxConfigWind = m.windGw[d.bestFb];
        chosen.maxConfigBatt = m.battGwh[d.bestFb];
        const off = m.surfaceOff[d.bestFb] === 1;
        const split = denseWindSplit(m.windGw[d.bestFb], off);
        fbOn = split.on; fbOff = split.off; fbSurface = off ? 'off' : 'on';
    }
    chosen.maxConfigLcoe = st.fbLcoe;
    const hasNoWind = st.hasNw || d.bestFbNoWind >= 0;
    const noWindLcoe = st.hasNw ? st.nwLcoe : d.bestFbNoWindLcoe;
    chosen.noWindLcoe = hasNoWind ? noWindLcoe : null;
    chosen.noWindMeetsTarget = st.hasNw;
    chosen.windSaving = (Number.isFinite(chosen.lcoe) && hasNoWind && Number.isFinite(noWindLcoe))
        ? noWindLcoe - chosen.lcoe : null;
    const sGw = chosen.solar_gw || 0, wGw = chosen.wind_gw || 0;
    chosen.windShare = (sGw + wGw) > 0 ? wGw / (sGw + wGw) : 0;
    chosen.windSurfaces = includeOffshore ? 'both' : 'onshore';
    addonTail(chosen, fields);
    chosen.maxConfigWindOn = fbOn;
    chosen.maxConfigWindOff = fbOff;
    chosen.maxConfigSurface = fbSurface;
    // The no-wind comparator's build: whether a slider (configs.json) build without
    // wind meets the target, and the no-wind build behind noWindLcoe (large or dense).
    const nwIdx = d.bestNoWind >= 0 ? d.bestNoWind : d.bestFbNoWind;
    chosen.noWindStdMeets = d.bestNoWind >= 0;
    chosen.noWindAddon = st.noWind ? 'large' : null;
    chosen.noWindSolar = st.noWind ? st.noWind.solar : (nwIdx >= 0 ? m.solarGw[nwIdx] : null);
    chosen.noWindBatt = st.noWind ? st.noWind.batt : (nwIdx >= 0 ? m.battGwh[nwIdx] : null);
    chosen.noWindStdLcoe = d.bestNoWind >= 0 ? d.bestNoWindLcoe : null;
    return chosen;
}

/**
 * Highest firm CF per location whose LCOE is within the target, searching the
 * full grid; the cheapest build where none is. Ties: first in config order.
 */
function computeCfAtTargetLcoeMatrix(payload) {
    const { targetLcoe } = payload;
    const includeOffshore = payload.params?.includeOffshore !== false;
    const offMask = techOffMask(payload.params);
    const m = STATE.matrix;
    const { cf, locationIds, nCfg, lcoeBuf } = m;
    const results = [];
    for (let li = 0; li < locationIds.length; li++) {
        const pre = locationPre(payload, li);
        fillLocationLcoe(m, li, pre);
        dropExcluded(m, offMask);
        const includeDieselBackup = pre.includeDieselBackup;
        let best = -1, bestFirm = 0, bestLcoe = 0;
        let cheapest = -1, cheapestLcoe = 0;
        const base = li * nCfg;
        for (let ci = 0; ci < nCfg; ci++) {
            const lcoe = lcoeBuf[ci];
            if (lcoe !== lcoe) continue;                 // NaN: skipped config
            if (lcoe <= targetLcoe) {
                // firm_cf exactly as computeLcoeMetrics sets it.
                const firmCf = includeDieselBackup ? 1 : clampCf(cf[base + ci]);
                if (best < 0 || firmCf > bestFirm || (firmCf === bestFirm && lcoe < bestLcoe)) {
                    best = ci; bestFirm = firmCf; bestLcoe = lcoe;
                }
            }
            if (cheapest < 0 || lcoe < cheapestLcoe) { cheapest = ci; cheapestLcoe = lcoe; }
        }
        if (STATE.addon) {
            const st = newBudgetState();
            st.hasBest = best >= 0; st.bestFirm = bestFirm; st.bestLcoe = bestLcoe;
            st.hasCheap = cheapest >= 0; st.cheapLcoe = cheapestLcoe;
            addonPassBudget(STATE.addon, li, pre, targetLcoe, includeOffshore, st, offMask);
            if (!st.hasCheap) continue;
            const cand = st.hasBest ? st.best : st.cheap;
            let chosen, fields = null;
            if (cand) ({ entry: chosen, fields } = addonEntry(m, li, cand, pre));
            else chosen = matrixEntry(m, li, best >= 0 ? best : cheapest, pre);
            chosen.targetLcoe = targetLcoe;
            chosen.meetsTarget = st.hasBest;
            chosen.windSurfaces = includeOffshore ? 'both' : 'onshore';
            addonTail(chosen, fields);
            results.push(chosen);
            continue;
        }
        if (cheapest < 0) continue;
        const chosen = matrixEntry(m, li, best >= 0 ? best : cheapest, pre);
        chosen.targetLcoe = targetLcoe;
        chosen.meetsTarget = best >= 0;
        chosen.windSurfaces = includeOffshore ? 'both' : 'onshore';
        results.push(chosen);
    }
    return sortByLocationId(results);
}

// Fetch and decode the grid in this thread: the loader's job, or the LCOE
// worker's own when it cannot start a loader.
async function decodeMatrix({ configs, locationIds, addon }, onProgress) {
    const { loadCfMatrix, loadAddon, gridFetcher } = await import('../data.js');
    const ids = Array.from(new Int32Array(locationIds));
    // Files download three ahead of the decode, the add-on's while the last
    // slices decode (T094); each is still decoded and filled in the same order.
    const fetcher = gridFetcher(configs, addon || null);
    const m = await loadCfMatrix(configs, ids, (done, total) => onProgress({ done, total }), fetcher);
    // The add-on (T058), only when the page asks for it. A failure (missing file,
    // SHA-256 mismatch) leaves the grid as it is and is reported, not thrown.
    m.addon = null;
    m.addonError = null;
    if (addon) {
        try {
            m.addon = await loadAddon(addon.manifest, ids, addon.sets || null, null, fetcher);
        } catch (error) {
            m.addonError = error?.message || String(error);
        }
    }
    return m;
}

const MATRIX_ARRAYS = {
    cf: Float32Array, locationIds: Int32Array,
    solarGw: Int8Array, windGw: Int8Array, battGwh: Int8Array, surfaceOff: Uint8Array
};

// The grid from a loader worker, or decoded here if no loader can be started.
function decodeMatrixInLoader(payload, onProgress) {
    let loader = null;
    try {
        if (typeof Worker !== 'undefined') {
            loader = new Worker(new URL('./lcoe-worker.js?load', import.meta.url), { type: 'module' });
        }
    } catch (_) { /* no nested module workers: decode here */ }
    if (!loader) return decodeMatrix(payload, onProgress);
    const ids = payload.locationIds.slice(0);    // kept in case the loader fails to start
    return new Promise((resolve, reject) => {
        let started = false;
        loader.onmessage = (event) => {
            const { type, payload: data } = event.data || {};
            started = true;
            if (type === 'PROGRESS') {
                onProgress(data);
                return;
            }
            loader.terminate();
            if (type !== 'RESULT') {
                reject(new Error(data?.message || 'matrix loader failed'));
                return;
            }
            const m = { nLoc: data.nLoc, nCfg: data.nCfg };
            for (const [key, Type] of Object.entries(MATRIX_ARRAYS)) m[key] = new Type(data[key]);
            m.addon = data.addon || null;
            m.addonError = data.addonError || null;
            resolve(m);
        };
        loader.onerror = (event) => {
            event.preventDefault();
            loader.terminate();
            if (started) reject(new Error(event.message || 'matrix loader failed'));
            else decodeMatrix({ ...payload, locationIds: ids }, onProgress).then(resolve, reject);
        };
        loader.postMessage(payload, [payload.locationIds]);
    });
}

async function loadMatrix(requestId, payload) {
    const m = await decodeMatrixInLoader(payload, (progress) => {
        self.postMessage({ type: 'PROGRESS', requestId, payload: progress });
    });
    buildMatrixLevels(m);
    STATE.addon = m.addon || null;
    delete m.addon;
    STATE.matrix = m;
    if (m.addonError) console.error(`Add-on builds not used: ${m.addonError}`);
    return {
        kind: 'LOAD_MATRIX', ready: true, nLoc: m.nLoc, nCfg: m.nCfg,
        addon: STATE.addon ? Object.keys(STATE.addon.sets) : null,
        addonError: m.addonError || null
    };
}

function requireMatrix() {
    if (!STATE.matrix) throw new Error('CF matrix not loaded');
    return STATE.matrix;
}

/**
 * Rows as columns, so an answer crosses threads as a few transferred typed
 * arrays instead of thousands of cloned objects: one Float64Array per field,
 * plus, for fields that are not always numbers, a per-row tag and a dictionary
 * of the other values (strings, booleans, null, undefined). The main thread
 * rebuilds the same rows, key order included. Rows of differing shapes are
 * sent as they are.
 */
function encodeRows(rows) {
    const n = rows.length;
    const keys = n ? Object.keys(rows[0]) : [];
    for (let i = 1; i < n; i++) {
        const k = Object.keys(rows[i]);
        if (k.length !== keys.length) return { payload: { rows }, transfer: [] };
        for (let j = 0; j < k.length; j++) {
            if (k[j] !== keys[j]) return { payload: { rows }, transfer: [] };
        }
    }
    const transfer = [];
    const cols = keys.map((key) => {
        const num = new Float64Array(n);
        let tag = null, dict = null, codes = null;
        for (let i = 0; i < n; i++) {
            const v = rows[i][key];
            if (typeof v === 'number') { num[i] = v; continue; }
            if (!tag) { tag = new Uint8Array(n); dict = []; codes = new Map(); }
            let code = codes.get(v);
            if (code === undefined) { code = dict.length; dict.push(v); codes.set(v, code); }
            tag[i] = 1;
            num[i] = code;
        }
        transfer.push(num.buffer);
        if (!tag) return { num };
        transfer.push(tag.buffer);
        return { num, tag, dict };
    });
    return { payload: { columns: { n, keys, cols } }, transfer };
}

async function handleMessage(type, requestId, payload) {
    if (type === 'LOAD_MATRIX') {
        self.postMessage({ type: 'RESULT', requestId, payload: await loadMatrix(requestId, payload) });
        return;
    }

    if (type === 'ADDON_PAIR') {
        // One combined build's rows for the page's capacity map, from the CSR held here (T058).
        const set = STATE.addon?.sets?.wind_mix;
        if (!set) throw new Error('no wind_mix add-on loaded');
        const cols = addonPairColumns(set, requireMatrix().locationIds, payload.on, payload.off);
        self.postMessage({ type: 'RESULT', requestId, payload: cols },
            ['id', 'solar', 'batt', 'cf', 'curt'].map(k => cols[k].buffer));
        return;
    }

    if (type === 'SET_LOOKUPS') {
        STATE.lookups = payload || {};
        self.postMessage({ type: 'RESULT', requestId, payload: { kind: 'SET_LOOKUPS', ready: true } });
        return;
    }

    if (type === 'COMPUTE_BEST_LCOE' || type === 'COMPUTE_CF_AT_TARGET_LCOE') {
        requireMatrix();
        const rows = type === 'COMPUTE_BEST_LCOE'
            ? computeBestLcoeMatrix(payload || {})
            : computeCfAtTargetLcoeMatrix(payload || {});
        const { payload: reply, transfer } = encodeRows(rows);
        self.postMessage({ type: 'RESULT', requestId, payload: { kind: type, ...reply } }, transfer);
        return;
    }

    self.postMessage({
        type: 'ERROR',
        requestId,
        payload: { message: `Unknown message type: ${type}` }
    });
}

if (LOADER) {
    self.onmessage = async (event) => {
        try {
            if (event.data?.type === 'LOAD_SLICE') {
                // One summary slice for the main thread, as transferable columns.
                const { decodeSummarySlice, SLICE_KEYS } = await import('../data.js');
                const cols = await decodeSummarySlice(event.data.file, event.data.wasm);
                const transfer = SLICE_KEYS.map(key => cols[key]?.buffer).filter(Boolean);
                self.postMessage({ type: 'RESULT', payload: cols }, transfer);
                return;
            }
            if (event.data?.type === 'LOAD_ADDON_PAIR') {
                // One combined wind build's rows for the capacity map (T058).
                const { decodeAddonPair, ADDON_PAIR_KEYS } = await import('../data.js');
                const { manifest, on, off, wasm } = event.data;
                const cols = await decodeAddonPair(manifest, on, off, wasm);
                self.postMessage({ type: 'RESULT', payload: cols }, ADDON_PAIR_KEYS.map(key => cols[key].buffer));
                return;
            }
            const m = await decodeMatrix(event.data,
                (progress) => self.postMessage({ type: 'PROGRESS', payload: progress }));
            const reply = { nLoc: m.nLoc, nCfg: m.nCfg };
            for (const key of Object.keys(MATRIX_ARRAYS)) reply[key] = m[key].buffer;
            const transfer = Object.keys(MATRIX_ARRAYS).map(key => reply[key]);
            if (event.data.addon) {
                reply.addon = m.addon;
                reply.addonError = m.addonError;
                transfer.push(...addonTransferList(m.addon));
            }
            self.postMessage({ type: 'RESULT', payload: reply }, transfer);
        } catch (error) {
            self.postMessage({ type: 'ERROR', payload: { message: error?.message || String(error) } });
        }
    };
} else {
    // Messages are handled strictly in order, even while the matrix is still
    // loading, so lookups and searches always apply to the data sent before them.
    let queue = Promise.resolve();
    self.onmessage = (event) => {
        const { type, requestId, payload } = event.data || {};
        queue = queue.then(() => handleMessage(type, requestId, payload)).catch((error) => {
            self.postMessage({
                type: 'ERROR',
                requestId,
                payload: {
                    message: error?.message || String(error),
                    stack: error?.stack || null,
                    kind: type || null
                }
            });
        });
    };
}
