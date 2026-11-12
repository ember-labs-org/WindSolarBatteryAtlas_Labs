-- OPTION for take 3 only, not used in any atlas number (see the evidence file):
-- observed monthly solar and wind generation by country, Ember Monthly Electricity
-- Data (September 2026 release), 2023-2025. Each month's share of its year's
-- output per source, averaged over the three years; then the correlation of the
-- solar and wind monthly profiles and the share of each source's output that
-- falls in November-February. Fleet output, so capacity growth within a year
-- tilts shares towards later months; Nov-Feb is summer in the southern hemisphere.
WITH m AS (
  SELECT area, date_part('year', date) AS yr, date_part('month', date) AS mo, variable, value
  FROM ember.ember_monthly_full_release_long
  WHERE area_type = 'Country or economy' AND category = 'Electricity generation' AND unit = 'TWh'
    AND variable IN ('Solar', 'Wind') AND date >= DATE '2023-01-01' AND date < DATE '2026-01-01'),
s AS (SELECT area, yr, variable, mo, value / NULLIF(sum(value) OVER (PARTITION BY area, yr, variable), 0) AS share FROM m),
p AS (SELECT area, variable, mo, avg(share) AS share, count(*) AS nyr FROM s GROUP BY ALL),
w AS (SELECT area, mo, max(CASE WHEN variable = 'Solar' THEN share END) AS sol,
             max(CASE WHEN variable = 'Wind' THEN share END) AS wnd, min(nyr) AS nyr FROM p GROUP BY ALL)
SELECT area, round(corr(sol, wnd), 2) AS corr_monthly,
       round(sum(CASE WHEN mo IN (11, 12, 1, 2) THEN sol END) * 100, 1) AS solar_nov_feb_pct,
       round(sum(CASE WHEN mo IN (11, 12, 1, 2) THEN wnd END) * 100, 1) AS wind_nov_feb_pct
FROM w GROUP BY area HAVING count(*) = 12 AND min(nyr) = 3 ORDER BY corr_monthly;

-- Counts quoted in the evidence file (run 26 October 2026): 77 countries have
-- 12 months in all three years; 62 of them have both series (15 lack solar or
-- wind); 47 of the 62 show a negative correlation. By Ember region: Europe 34
-- (32 negative), Latin America and Caribbean 11 (3), Asia 9 (8), Africa 5 (1),
-- North America 2 (2), Oceania 1 (1) – the sample skews to Europe.
WITH m AS (
  SELECT area, date_part('year', date) AS yr, date_part('month', date) AS mo, variable, value
  FROM ember.ember_monthly_full_release_long
  WHERE area_type = 'Country or economy' AND category = 'Electricity generation' AND unit = 'TWh'
    AND variable IN ('Solar', 'Wind') AND date >= DATE '2023-01-01' AND date < DATE '2026-01-01'),
s AS (SELECT area, yr, variable, mo, value / NULLIF(sum(value) OVER (PARTITION BY area, yr, variable), 0) AS share FROM m),
p AS (SELECT area, variable, mo, avg(share) AS share, count(*) AS nyr FROM s GROUP BY ALL),
w AS (SELECT area, mo, max(CASE WHEN variable = 'Solar' THEN share END) AS sol,
             max(CASE WHEN variable = 'Wind' THEN share END) AS wnd, min(nyr) AS nyr FROM p GROUP BY ALL),
c AS (SELECT area, corr(sol, wnd) AS r FROM w GROUP BY area HAVING count(*) = 12 AND min(nyr) = 3),
reg AS (SELECT DISTINCT area, ember_region FROM ember.ember_monthly_full_release_long WHERE area_type = 'Country or economy')
SELECT reg.ember_region, count(*) AS rows_all, count(c.r) AS with_both_series, count(*) FILTER (WHERE c.r < 0) AS negative
FROM c LEFT JOIN reg USING (area) GROUP BY ROLLUP (reg.ember_region) ORDER BY with_both_series DESC;
