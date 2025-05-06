import requests
from datetime import datetime

BASE_URL = "http://localhost:3000"
API_TOKEN = "my-strong-secret-token"  # same as in your .env

HEADERS = {
    "x-api-token": API_TOKEN,
    "Content-Type": "application/json"
}

def send_whatsapp_message(to_number, text):
    try:
        payload = {
            "to": f"{to_number}@s.whatsapp.net",
            "message": text
        }
        response = requests.post(f"{BASE_URL}/api/send-message", json=payload, headers=HEADERS)
        response.raise_for_status()
        print("✅ Message sent successfully!")
    except requests.exceptions.HTTPError as errh:
        print("❌ HTTP error:", errh.response.text)
    except requests.exceptions.ConnectionError:
        print("❌ Connection error – is the bot running?")
    except Exception as e:
        print("❌ Unexpected error:", str(e))

def check_health():
    try:
        response = requests.get(f"{BASE_URL}/api/health", headers=HEADERS)
        response.raise_for_status()
        print("📡 Health Check:", response.json())
    except Exception as e:
        print("❌ Health check failed:", str(e))

def get_recent_messages():
    try:
        response = requests.get(f"{BASE_URL}/api/get-messages", headers=HEADERS)
        response.raise_for_status()
        messages = response.json()
        print("📬 Messages:")
        for msg in messages:
            print(f" - {msg['sender']} @ {msg['timestamp']} → {msg['messageContent']}")
    except Exception as e:
        print("❌ Could not fetch messages:", str(e))

def download_latest_media(after_iso_date, output_file):
    try:
        url = f"{BASE_URL}/media?after={after_iso_date}"
        response = requests.get(url, headers=HEADERS, stream=True)
        if response.status_code == 200:
            with open(output_file, 'wb') as f:
                for chunk in response.iter_content(1024):
                    f.write(chunk)
            print(f"💾 Media saved as: {output_file}")
        elif response.status_code == 404:
            print("⚠️ No media found after that date.")
        else:
            print("⚠️ Failed to download media:", response.text)
    except Exception as e:
        print("❌ Error downloading media:", str(e))

# --- Example usage ---

if __name__ == "__main__":
    phone="33660253264"
    message="Hello from Python with error handling!"
    check_health()
    #send_whatsapp_message(phone, message)
    get_recent_messages()
    download_latest_media("2025-04-25T00:00:00Z", "latest")
