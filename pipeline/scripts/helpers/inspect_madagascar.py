import geopandas as gpd
import rasterio
import pandas as pd
from shapely.geometry import Point, box
import numpy as np


from scripts.pipeline.config import INPUTS_DIR, OUTPUTS_DIR

# Madagascar approx center
madagascar_lat, madagascar_lon = -18.7669, 46.8691

path = INPUTS_DIR / "2019 elec demand" / "EC2019.tif"
voronoi_path = OUTPUTS_DIR / "voronoi_cells.geojson"

print(f"Inspecting Madagascar ({madagascar_lat}, {madagascar_lon})...")

# Check Raster Value
with rasterio.open(path) as src:
    print(f"Raster CRS: {src.crs}")
    
    # Reproject point to Raster CRS
    # Simple approach: create a 1-point GDF
    pt_gdf = gpd.GeoDataFrame(geometry=[Point(madagascar_lon, madagascar_lat)], crs="EPSG:4326")
    pt_proj = pt_gdf.to_crs(src.crs)
    x, y = pt_proj.geometry[0].x, pt_proj.geometry[0].y
    
    print(f"Projected Coords: {x}, {y}")
    
    # Sample
    row, col = src.index(x, y)
    print(f"Row: {row}, Col: {col}")
    
    # Read window around it
    window = rasterio.windows.Window(col-2, row-2, 5, 5)
    data = src.read(1, window=window)
    print("Raster Data (5x5 around center):")
    print(data)
    
    # Check if bounds cover it
    print(f"Raster Bounds: {src.bounds}")
    in_bounds = (src.bounds.left <= x <= src.bounds.right) and (src.bounds.bottom <= y <= src.bounds.top)
    print(f"Point in bounds? {in_bounds}")


# Check Voronoi cells in that area
print("\nChecking Voronoi Cells...")
gdf = gpd.read_file(voronoi_path)
gdf_mad = gdf.cx[43:51, -26:-11] # Roughly Madagascar bounding box
print(f"Found {len(gdf_mad)} Voronoi cells in/near Madagascar")

# Check output csv for these cells
df = pd.read_csv(OUTPUTS_DIR / "voronoi_electricity_demand.csv")
print(f"CSV Columns: {df.columns.tolist()}")
merged = gdf_mad.merge(df, on="location_id")
print("\nSample Voronoi Results (Madagascar):")
# After merge, if lat/lon in both, they get suffixes (e.g. latitude_x, latitude_y)
# Voronoi (GDF) usually has them. CSV has them.
# Let's check available columns
print(f"Merged Columns: {merged.columns.tolist()}")

# Just print annual_demand_kwh
cols = ['location_id', 'annual_demand_kwh']
if 'latitude' in merged.columns: cols.extend(['latitude', 'longitude'])
elif 'latitude_x' in merged.columns: cols.extend(['latitude_x', 'longitude_x'])

print(merged[cols].head(10))

# Summary stats for this region
print("\nMadagascar Region Stats:")
print(f"Total Cells: {len(merged)}")
non_zero = merged[merged['annual_demand_kwh'] > 0]
print(f"Non-Zero Cells: {len(non_zero)}")
print(f"Total Demand: {merged['annual_demand_kwh'].sum()} kWh")

# Check raster stats for the whole region just to be sure we aren't missing slightly offset pixels
if len(non_zero) == 0:
    print("\nWARNING: No demand found in Madagascar Voronoi cells.")
    print("Checking if raster has ANY data in this bounding box...")
    
    with rasterio.open(path) as src:
        # Reproject bounds
        mad_box = box(43, -26, 51, -11) # approx madagascar
        # Create a gdf
        bbox_gdf = gpd.GeoDataFrame(geometry=[mad_box], crs="EPSG:4326")
        bbox_proj = bbox_gdf.to_crs(src.crs)
        
        b = bbox_proj.geometry[0].bounds
        window = rasterio.windows.from_bounds(*b, transform=src.transform)
        
        data = src.read(1, window=window)
        print(f"Raster Window Shape: {data.shape}")
        print(f"Min: {data.min()}, Max: {data.max()}, Mean: {data.mean()}")
        print(f"Non-zero count in raster: {np.count_nonzero(data)}")



