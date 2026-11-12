import requests
import xml.etree.ElementTree as ET

def search_s3_keys(bucket, prefix, search_term):
    print(f"Searching in {bucket}/{prefix} for '{search_term}'...")
    url = f"https://{bucket}.s3.amazonaws.com/?list-type=2&prefix={prefix}"
    
    try:
        response = requests.get(url)
        if response.status_code != 200:
            print(f"Error accessing bucket: {response.status_code}")
            return

        root = ET.fromstring(response.content)
        ns = {'s3': 'http://s3.amazonaws.com/doc/2006-03-01/'}
        
        keys = [k.text for k in root.findall('.//s3:Key', ns)]
        
        found = []
        for k in keys:
            if search_term in k:
                found.append(k)
        
        if found:
            print(f"Found {len(found)} matches:")
            for f in found[:10]:
                print(f" - {f}")
        else:
            print("No matches found.")
            
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    # Check HREAv1.1_COGs/AFG/AFG/ for any other folders besides rade9lnmu
    search_s3_keys("globalnightlight", "HREAv1.1_COGs/AFG/AFG/", "pelec")
    search_s3_keys("globalnightlight", "HREAv1.1_COGs/AFG/AFG/", "prob")
    search_s3_keys("globalnightlight", "HREAv1.1_COGs/AFG/AFG/", "electrification")
    
    # Check if there is a 'pelec' folder at country level
    search_s3_keys("globalnightlight", "HREAv1.1_COGs/AFG/", "pelec")
    
    # Check root for 'pelec'
    search_s3_keys("globalnightlight", "", "pelec")
