import requests

def probe_token():
    url = "https://planetarycomputer.microsoft.com/api/sas/v1/token/hrea"
    print(f"Requesting SAS token from {url}...")
    
    try:
        resp = requests.get(url)
        print(f"Status: {resp.status_code}")
        if resp.status_code == 200:
            data = resp.json()
            token = data.get("token")
            print(f"Token obtained: {token[:10]}...")
            return token
        else:
            print("Failed to get token.")
            return None
            
    except Exception as e:
        print(f"Error: {e}")
        return None

if __name__ == "__main__":
    probe_token()
