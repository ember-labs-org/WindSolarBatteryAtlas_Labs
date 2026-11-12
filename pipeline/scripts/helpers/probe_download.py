import requests

def probe_download():
    url = "https://hreadatasa.blob.core.windows.net/hrea/HREA/HREA_Zimbabwe_2019_v1/Zimbabwe_set_prplit_conf90_sy_2019.tif"
    print(f"Attempting to download {url}...")
    
    try:
        resp = requests.get(url, stream=True)
        print(f"Status: {resp.status_code}")
        if resp.status_code == 200:
            print("Success! Content-Length:", resp.headers.get('content-length'))
            # Check first few bytes to confirm TIFF
            chunk = next(resp.iter_content(chunk_size=4))
            print(f"Header: {chunk}")
        elif resp.status_code == 404:
            print("File not found.")
        elif resp.status_code == 403:
            print("Access denied (likely needs SAS token).")
            
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    probe_download()
