import requests
import json

def probe_mpc():
    print("Querying Microsoft Planetary Computer STAC API for HREA items...")
    
    # Collection ID: hrea
    # Endpoint for items
    url = "https://planetarycomputer.microsoft.com/api/stac/v1/collections/hrea/items"
    
    params = {
        "limit": 5
    }
    
    try:
        resp = requests.get(url, params=params)
        if resp.status_code != 200:
            print(f"Error: {resp.status_code}")
            return
            
        data = resp.json()
        features = data.get("features", [])
        print(f"Found {len(features)} items.")
        
        if features:
            item = features[0]
            print(f"Item ID: {item['id']}")
            print("Assets:")
            for key, asset in item['assets'].items():
                print(f"  - {key}: {asset['href']}")
                if "pelec" in key or "prob" in key or "data" in key:
                    print(f"    (Potential target)")
                    
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    probe_mpc()
