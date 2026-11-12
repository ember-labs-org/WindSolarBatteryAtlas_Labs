import pandas as pd

from scripts.pipeline.config import OUTPUTS_DIR

df = pd.read_csv(OUTPUTS_DIR / "voronoi_electricity_demand.csv")

# New York City approx (40.7, -74.0)
nyc = df[
    (df['latitude'].between(40, 42)) & 
    (df['longitude'].between(-75, -73))
]

print("\nNew York Area:")
print(nyc[['latitude', 'longitude', 'annual_demand_kwh']].head(5))
print(f"Total NYC Area Demand: {nyc['annual_demand_kwh'].sum()} kWh")

# London approx (51.5, -0.1)
london = df[
    (df['latitude'].between(51, 52)) & 
    (df['longitude'].between(-1, 0.5))
]
print("\nLondon Area:")
print(london[['latitude', 'longitude', 'annual_demand_kwh']].head(5))
print(f"Total London Area Demand: {london['annual_demand_kwh'].sum()} kWh")

# Check global zero count again
print(f"\nGlobal Zero Count: {len(df[df['annual_demand_kwh'] == 0])} / {len(df)}")
