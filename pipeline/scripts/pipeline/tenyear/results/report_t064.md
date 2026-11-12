## Slices: mean annual_cf, T060 data_10y -> T064 data_10y (deployed rows)

| File | T060 10y | T064 10y | Change | Predicted | T064 2024 | Rows changed |
|---|---|---|---|---|---|---|
| summary_w0.parquet | 69.9% | 69.9% | +0.00 pts | +0.00 pts | 69.8% | 0 of 1,294,850 |
| summary_w1.parquet | 73.5% | 71.7% | -1.81 pts | -1.84 pts | 71.7% | 750,669 of 933,185 |
| summary_w2.parquet | 83.7% | 81.7% | -1.98 pts | -2.00 pts | 81.9% | 737,119 of 933,185 |
| summary_w3.parquet | 87.3% | 85.6% | -1.68 pts | -1.69 pts | 85.8% | 726,385 of 933,185 |
| summary_w4.parquet | 89.2% | 87.8% | -1.49 pts | -1.49 pts | 87.9% | 717,238 of 933,185 |
| summary_w5.parquet | 90.5% | 89.1% | -1.35 pts | -1.35 pts | 89.3% | 708,664 of 933,185 |
| summary_w6.parquet | 91.3% | 90.1% | -1.25 pts | -1.25 pts | 90.3% | 701,322 of 933,185 |
| summary_w8.parquet | 92.5% | 91.4% | -1.11 pts | -1.11 pts | 91.6% | 687,771 of 933,185 |
| summary_wo1.parquet | 60.5% | 58.9% | -1.55 pts | -1.56 pts | 58.8% | 260,885 of 933,185 |
| summary_wo2.parquet | 63.6% | 62.0% | -1.62 pts | -1.61 pts | 62.0% | 258,220 of 933,185 |
| summary_wo3.parquet | 64.5% | 63.2% | -1.38 pts | -1.37 pts | 63.1% | 256,406 of 933,185 |
| summary_wo4.parquet | 65.0% | 63.8% | -1.24 pts | -1.22 pts | 63.7% | 254,422 of 933,185 |
| summary_wo5.parquet | 65.3% | 64.2% | -1.14 pts | -1.12 pts | 64.1% | 253,014 of 933,185 |
| summary_wo6.parquet | 65.5% | 64.5% | -1.07 pts | -1.05 pts | 64.4% | 251,415 of 933,185 |
| summary_wo8.parquet | 65.8% | 64.9% | -0.97 pts | -0.96 pts | 64.8% | 248,586 of 933,185 |

## Profiles: mean CF of the hourly inputs, deployed regions with a profile

| Tech | T060 2024 | T060 10y | T064 2024 | T064 10y | Median 10y ÷ 2024, T060 → T064 | 2024 rank (1 = best), T060 → T064 | Level gap 10y ÷ target |
|---|---|---|---|---|---|---|---|
| solar | 15.1% | 15.3% | 15.1% | 15.3% | 1.0085 → 1.0085 | 10 → 10 |  |
| wind_on | 31.5% | 31.4% | 28.4% | 28.3% | 0.9922 → 0.9920 | 5 → 6 | 0.979 (2024: 1.000) |
| wind_off | 37.7% | 37.3% | 29.3% | 28.9% | 0.9878 → 0.9859 | 1 → 2 | 0.985 (2024: 1.000) |

## City curves (cheapest build with wind, $/MWh, global costs 2026)

| City (id) | Target | T060 10y | T064 2024 | T064 10y | 10y change T060 → T064 | T061's 2024 change | Build at target, T064 10y |
|---|---|---|---|---|---|---|---|
| Tromsø (3459) | 80% | $99 | $85 | $92 | -7 | -5 | s3 w3on b8 |
| Tromsø (3459) | 90% | $125 | $106 | $117 | -8 | -4 | s5 w3on b20 |
| Tromsø (3459) | 99% | $214 | $167 | $240 | +26 | +3 | s8 w5both b36 |
| Stockholm (3882) | 80% | $58 | $74 | $70 | +13 | +15 | s3 w2on b6 |
| Stockholm (3882) | 90% | $75 | $89 | $88 | +14 | +12 | s4 w3on b8 |
| Stockholm (3882) | 99% | $140 | $143 | $168 | +28 | +17 | s4 w6on b36 |
| Edinburgh (2164) | 80% | $46 | $69 | $66 | +20 | +23 | s3 w2on b4 |
| Edinburgh (2164) | 90% | $65 | $87 | $83 | +18 | +21 | s5 w2on b10 |
| Edinburgh (2164) | 99% | $119 | $174 | $156 | +37 | +51 | s7 w4on b34 |
| Berlin (3043) | 80% | $58 | $69 | $66 | +9 | +11 | s3 w2on b4 |
| Berlin (3043) | 90% | $73 | $86 | $87 | +14 | +11 | s5 w2on b12 |
| Berlin (3043) | 99% | $133 | $209 | $154 | +21 | +38 | s5 w5on b32 |
| London (768) | 80% | $57 | $66 | $66 | +9 | +8 | s3 w2on b4 |
| London (768) | 90% | $72 | $84 | $83 | +11 | +8 | s5 w2on b10 |
| London (768) | 99% | $133 | $430 | $156 | +23 | +210 | s8 w4on b30 |
| Chicago (3645) | 80% | $57 | $54 | $58 | +1 | +0 | s2 w2on b4 |
| Chicago (3645) | 90% | $66 | $66 | $69 | +3 | +0 | s3 w2on b10 |
| Chicago (3645) | 99% | $107 | $108 | $110 | +3 | +1 | s5 w3on b22 |
| Madrid (3926) | 80% | $68 | $76 | $75 | +7 | +8 | s5 w1on b10 |
| Madrid (3926) | 90% | $79 | $90 | $86 | +7 | +6 | s7 w1on b12 |
| Madrid (3926) | 99% | $129 | $159 | $149 | +21 | +21 | s10 w3on b26 |
| Beijing (250) | 80% | $54 | $65 | $62 | +8 | +10 | s2 w2on b6 |
| Beijing (250) | 90% | $66 | $76 | $73 | +7 | +7 | s4 w2on b8 |
| Beijing (250) | 99% | $106 | $112 | $115 | +10 | +7 | s9 w2on b18 |
| Dallas (3953) | 80% | $52 | $52 | $52 | +1 | +2 | s2 w2on b2 |
| Dallas (3953) | 90% | $59 | $62 | $62 | +3 | +3 | s3 w2on b6 |
| Dallas (3953) | 99% | $99 | $104 | $100 | +1 | +3 | s5 w3on b16 |
| Delhi (4922) | 80% | $74 | $76 | $74 | +0 | +0 | s6 w0 b14 |
| Delhi (4922) | 90% | $81 | $85 | $81 | +0 | +0 | s8 w0 b14 |
| Delhi (4922) | 99% | $126 | $196 | $126 | +0 | +8 | s15 w0 b18 |
| Lagos (228) | 80% | $69 | $69 | $69 | +0 | +0 | s6 w0 b12 |
| Lagos (228) | 90% | $72 | $73 | $72 | +0 | +0 | s7 w0 b14 |
| Lagos (228) | 99% | $85 | $89 | $87 | +2 | +4 | s9 w0 b18 |
| Jakarta (3268) | 80% | $68 | $68 | $68 | +0 | +0 | s6 w0 b12 |
| Jakarta (3268) | 90% | $71 | $72 | $71 | +0 | +0 | s6 w0 b16 |
| Jakarta (3268) | 99% | $88 | $87 | $88 | +0 | +0 | s9 w0 b18 |
| Johannesburg (3367) | 80% | $58 | $59 | $61 | +4 | +6 | s4 w1on b6 |
| Johannesburg (3367) | 90% | $65 | $65 | $68 | +2 | +4 | s5 w1on b10 |
| Johannesburg (3367) | 99% | $82 | $82 | $85 | +3 | +3 | s7 w1on b16 |
| Buenos Aires (2655) | 80% | $51 | $53 | $53 | +2 | +3 | s2 w2on b2 |
| Buenos Aires (2655) | 90% | $62 | $63 | $62 | +1 | +1 | s3 w2on b6 |
| Buenos Aires (2655) | 99% | $99 | $102 | $99 | +0 | +3 | s7 w2on b16 |
| Melbourne (920) | 80% | $50 | $53 | $51 | +1 | +1 | s1 w2on b4 |
| Melbourne (920) | 90% | $62 | $66 | $62 | +0 | +0 | s3 w2on b6 |
| Melbourne (920) | 99% | $102 | $115 | $102 | +0 | +3 | s8 w2on b14 |

## Headline model values

| Key | T060 10y | T064 2024 | T064 10y |
|---|---|---|---|
| hw.lower.demand.80 | 87.7% | 85.8% | 85.3% |
| hw.lower.demand.90 | 86.4% | 85.0% | 84.3% |
| hw.lower.demand.99 | 86.9% | 82.1% | 83.8% |
| hw.lower.people.80 | 65.0% | 58.2% | 57.4% |
| hw.lower.people.90 | 60.6% | 56.0% | 53.3% |
| hw.lower.people.99 | 68.0% | 63.6% | 60.4% |
| hw.lowerStd.demand.80 | 81.7% | 79.8% | 79.3% |
| hw.lowerStd.demand.90 | 68.6% | 67.1% | 66.5% |
| hw.lowerStd.demand.99 | 45.4% | 43.0% | 43.7% |
| hw.lowerStd.people.80 | 63.7% | 57.0% | 56.1% |
| hw.lowerStd.people.90 | 54.7% | 50.1% | 47.4% |
| hw.lowerStd.people.99 | 48.7% | 44.3% | 42.0% |
| t1.cut.people.80 | 11.3% | 8.2% | 7.2% |
| t1.cut.people.90 | 9.8% | 7.5% | 4.9% |

Bound article numbers: 89 distinct keys. T064 2024 → T064 10y: 24 read differently; T060 10y → T064 10y: 35 read differently.

| Key | T060 10y | T064 2024 | T064 10y |
|---|---|---|---|
| hw.lower.demand.90 | 86% | 85% | 84% |
| hw.lower.people.90 | 61% | 56% | 53% |
| hw.lower15.demand.90 | 70% | 65% | 66% |
| hw.lower15.people.90 | 35% | 31% | 32% |
| hw.medSaving.people.90 | $22 | $19 | $20 |
| t1.cheaper.demand.90 | 86% | 85% | 84% |
| t1.cut.demand.50 | 38% | 32% | 33% |
| t1.cut.demand.90 | 33% | 27% | 26% |
| t1.cut.people.90 | 10% | 8% | 5% |
| t1on.cheaper.demand.90 | 86% | 85% | 84% |
| t4.cut.n45p.80 | 63% | 56% | 57% |
| t4.lgSolar.n50p.90 | 85 | 70 | 85 |
| t4.lgWins.n50p.90 | 957 | 963 | 957 |
| t4.medWind.n50p.90 | $72 | $87 | $83 |
| t4.medWind.world.90 | $73 | $78 | $77 |
| t4.sbBoth.n45p.80 | $155 | $160 | $155 |
| t4.sbStd.n50p.90 | 4.0% | 3.4% | 4.0% |
| t4.windBoth.n45p.80 | $58 | $70 | $66 |
| t4.windBoth.n50p.90 | $72 | $87 | $83 |
| t4c.DE.medWind.90 | $76 | $87 | $89 |
| t4c.ES.medWind.90 | $76 | $87 | $84 |
| t4c.UK.medWind.90 | $72 | $87 | $83 |
| t5.cutMax | 33% | 27% | 26% |
| t5.windBoth.demand.2050 | $38 | $41 | $42 |

## Worst year of the cheapest ten-year slider builds (target met on the ten-year average)

| Target | Regions (slider build) | Short in ≥ 1 year | Median worst year | Median years short | Short in > 1 year of 10 |
|---|---|---|---|---|---|
| 80% | 4,451 | 71% | 78.9% | 2 | 57% |
| 90% | 4,428 | 80% | 88.8% | 3 | 69% |
| 99% | 4,023 | 97% | 98.3% | 4 | 91% |
