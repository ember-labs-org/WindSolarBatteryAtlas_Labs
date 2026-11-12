import rasterio
import numpy as np
from pathlib import Path

def inspect_raster(path):
    print(f"Inspecting {path}...")
    try:
        with rasterio.open(path) as src:
            print(f"  Shape: {src.shape}")
            print(f"  Count: {src.count}")
            print(f"  Dtype: {src.dtypes[0]}")
            print(f"  Nodata: {src.nodata}")
            
            data = src.read(1, masked=True)
            print(f"  Min: {data.min()}")
            print(f"  Max: {data.max()}")
            print(f"  Mean: {data.mean()}")
            
            # Check unique values
            unique = np.unique(data.compressed())
            print(f"  Unique values (first 10): {unique[:10]}")
            print(f"  Unique values (last 10): {unique[-10:]}")
            
            # Check if likely 0-1 or 0-100
            if data.max() > 1.0:
                print("  => Values > 1.0 detected.")
            else:
                print("  => Values are <= 1.0.")

    except Exception as e:
        print(f"Error: {e}")

from scripts.pipeline.config import CACHE_DIR

if __name__ == "__main__":
    # Find any cached file
    cache_dir = CACHE_DIR / "hrea_mpc"
    files = list(cache_dir.glob("*.tif"))
    if files:
        inspect_raster(files[0])
    else:
        print("No cached files found.")
