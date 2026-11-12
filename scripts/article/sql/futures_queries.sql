-- Queries run on Ember's futures MotherDuck database (share alias `futures`) on
-- 26 October 2026 for T040. Results are transcribed into inputs/external_figures.csv
-- (checked: column sums and a key-weighted sum match in SQL and Python).

-- IRENA RPGC 2025, figure B1.1: learning rates of total installed cost per
-- doubling of cumulative capacity (rows 1-6 solar PV, rows 9-14 onshore wind).
SELECT region, learning_rate, epsilon FROM irena_costs_full.f_b1_1_solar_pv_and_onshore_wind_learning_curves_per;

-- IRENA RPGC 2025, figure S2: global weighted-average LCOE, 2025 USD/MWh.
SELECT technology, year, lcoe_usd_mwh_2025real FROM irena_costs_full.f_s_2_lcoe_of_renewable_power_technologies_long
WHERE year IN (2010, 2025) AND technology IN ('Onshore wind', 'Offshore wind', 'Solar photovoltaic');

-- IRENA RPGC 2025, figure S4: cumulative reduction in global weighted-average TIC.
SELECT * FROM irena_costs_full.f_s4_cumulative_reduction_in_global_weighted_average;

-- OWID (Ziegler & Trancik 2021 and BloombergNEF): Li-ion cell price vs cumulative
-- production; learning rate = 1 - 2^slope of the log-log fit, ending 2023 (card trap).
WITH d AS (SELECT year, price_of_lithium_ion_battery_cells AS p, cumulative_production_of_lithium_ion_batteries AS q
           FROM owid.owid_battery_price_vs_cumulative_production WHERE p IS NOT NULL AND q IS NOT NULL AND q > 0)
SELECT '1991-2023' AS span, 1 - pow(2, regr_slope(ln(p), ln(q))) AS learning_rate FROM d
UNION ALL SELECT '2013-2023', 1 - pow(2, regr_slope(ln(p), ln(q))) FROM d WHERE year BETWEEN 2013 AND 2023;

-- Ember Yearly Electricity Data: world demand (check value India 2025 = 2,081 TWh reproduced).
SELECT year, value FROM ember.ember_yearly_full_release_long
WHERE area = 'World' AND category = 'Electricity demand' AND variable = 'Demand' AND unit = 'TWh' AND year IN (2019, 2025);
