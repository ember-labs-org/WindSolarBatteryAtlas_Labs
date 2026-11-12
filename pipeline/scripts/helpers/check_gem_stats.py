import pandas as pd
import numpy as np

from scripts.pipeline.config import OUTPUTS_DIR

csv_path = OUTPUTS_DIR / "voronoi_gem_capacity.csv"
df = pd.read_csv(csv_path)

print(f"Total cells: {len(df)}")
cols = [c for c in df.columns if "mw" in c or "Existing" in c or "Announced" in c]
print(f"Capacity columns: {cols}")

# Check totals
totals = df[cols].sum().sort_values(ascending=False)
print("\nGlobal Totals (GW):")
print(totals / 1000)

# Check coverage
print("\nNon-zero cell counts:")
non_zero = (df[cols] > 0).sum()
print(non_zero)

# Check outliers
print("\nMax value per cell (MW):")
print(df[cols].max())

# Geographic check
print("\nGeographic bounds of cells with > 0 capacity:")
active_mask = df[cols].sum(axis=1) > 0
active_df = df[active_mask]
print(f"Lat range: {active_df['latitude'].min():.2f} to {active_df['latitude'].max():.2f}")
print(f"Lon range: {active_df['longitude'].min():.2f} to {active_df['longitude'].max():.2f}")

# Check specific regions if possible (simple box check)
# US approx: Lat 25-50, Lon -125 to -65
us_mask = (active_df['latitude'].between(25, 50)) & (active_df['longitude'].between(-125, -65))
print(f"\nActive cells in US approx box: {us_mask.sum()}")
