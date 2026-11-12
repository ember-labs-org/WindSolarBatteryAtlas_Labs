-- Take 3 of "Harnessing the Winds": observed monthly solar and wind output.
-- Source: Ember, Monthly Electricity Data (September 2026 release), in Ember's
-- futures MotherDuck database (share alias `futures`), table
-- ember.ember_monthly_full_release_long. Run 27 October 2026 (T041).
--
-- These are national fleet output, not the atlas's model. Fleet output, so
-- capacity added during a year tilts its shares towards later months.
-- Method as scripts/article/sql/take3_option_ember_monthly.sql (T040): each
-- month's share of its year's output per source, averaged over 2023-2025.
--
-- Query 1 writes data/ember_monthly_germany_2023_2025.csv (all digits).
WITH m AS (
  SELECT area, date_part('year', date) AS yr, date_part('month', date) AS mo, variable, value
  FROM ember.ember_monthly_full_release_long
  WHERE area_type = 'Country or economy' AND category = 'Electricity generation' AND unit = 'TWh'
    AND variable IN ('Solar', 'Wind') AND date >= DATE '2023-01-01' AND date < DATE '2026-01-01'
    AND area = 'Germany'),
s AS (SELECT area, yr, variable, mo, value / NULLIF(sum(value) OVER (PARTITION BY area, yr, variable), 0) AS share FROM m),
p AS (SELECT area, variable, mo, avg(share) AS share, count(*) AS nyr FROM s GROUP BY ALL)
SELECT mo AS month,
       max(CASE WHEN variable = 'Solar' THEN share END) AS solar_share,
       max(CASE WHEN variable = 'Wind' THEN share END) AS wind_share,
       min(nyr) AS years
FROM p GROUP BY mo ORDER BY mo;

-- Query 2 writes data/ember_monthly_complement_2023_2025.csv (the eight
-- countries quoted in the evidence file) and gives the counts n_both = 62
-- (countries with 12 months of both series in all three years) and n_neg = 47
-- (negative monthly correlation). Query 3 gives the regional split.
WITH m AS (
  SELECT area, date_part('year', date) AS yr, date_part('month', date) AS mo, variable, value
  FROM ember.ember_monthly_full_release_long
  WHERE area_type = 'Country or economy' AND category = 'Electricity generation' AND unit = 'TWh'
    AND variable IN ('Solar', 'Wind') AND date >= DATE '2023-01-01' AND date < DATE '2026-01-01'),
s AS (SELECT area, yr, variable, mo, value / NULLIF(sum(value) OVER (PARTITION BY area, yr, variable), 0) AS share FROM m),
p AS (SELECT area, variable, mo, avg(share) AS share, count(*) AS nyr FROM s GROUP BY ALL),
w AS (SELECT area, mo, max(CASE WHEN variable = 'Solar' THEN share END) AS sol,
             max(CASE WHEN variable = 'Wind' THEN share END) AS wnd, min(nyr) AS nyr FROM p GROUP BY ALL),
c AS (SELECT area, round(corr(sol, wnd), 2) AS corr_monthly,
             round(sum(CASE WHEN mo IN (11, 12, 1, 2) THEN sol END) * 100, 1) AS solar_nov_feb_pct,
             round(sum(CASE WHEN mo IN (11, 12, 1, 2) THEN wnd END) * 100, 1) AS wind_nov_feb_pct
      FROM w GROUP BY area HAVING count(*) = 12 AND min(nyr) = 3)
SELECT *, (SELECT count(*) FROM c WHERE corr_monthly IS NOT NULL) AS n_both,
          (SELECT count(*) FROM c WHERE corr_monthly < 0) AS n_neg
FROM c
WHERE area IN ('Germany', 'United Kingdom', 'Poland', 'France', 'Japan', 'United States of America', 'China', 'India')
ORDER BY corr_monthly;

-- Query 3 writes data/ember_monthly_counts_by_region_2023_2025.csv: countries with
-- 12 months in all three years (rows_all), with both series (with_both_series) and
-- with a negative monthly correlation (negative), by Ember region; '(all)' is the total.
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
SELECT coalesce(reg.ember_region, '(all)') AS ember_region, count(*) AS rows_all,
       count(c.r) AS with_both_series, count(*) FILTER (WHERE c.r < 0) AS negative
FROM c LEFT JOIN reg USING (area) GROUP BY ROLLUP (reg.ember_region) ORDER BY with_both_series DESC;

-- Query 4 (T077) writes data/ember_monthly_europe9_2023_2025.csv (all digits): Query 1's
-- monthly shares for the nine European countries of take 3's small multiples. Run
-- 2 November 2026; checksum against the file: 216 values, solar and wind shares each
-- sum to 9, sum of month x wind share 58.6457 (SQL and Python agree).
WITH m AS (
  SELECT area, date_part('year', date) AS yr, date_part('month', date) AS mo, variable, value
  FROM ember.ember_monthly_full_release_long
  WHERE area_type = 'Country or economy' AND category = 'Electricity generation' AND unit = 'TWh'
    AND variable IN ('Solar', 'Wind') AND date >= DATE '2023-01-01' AND date < DATE '2026-01-01'
    AND area IN ('Germany', 'United Kingdom', 'France', 'Spain', 'Italy', 'Poland', 'Netherlands', 'Sweden', 'Denmark')),
s AS (SELECT area, yr, variable, mo, value / NULLIF(sum(value) OVER (PARTITION BY area, yr, variable), 0) AS share FROM m),
p AS (SELECT area, variable, mo, avg(share) AS share, count(*) AS nyr FROM s GROUP BY ALL)
SELECT area, mo AS month,
       max(CASE WHEN variable = 'Solar' THEN share END) AS solar_share,
       max(CASE WHEN variable = 'Wind' THEN share END) AS wind_share,
       min(nyr) AS years
FROM p GROUP BY area, mo ORDER BY area, mo;
