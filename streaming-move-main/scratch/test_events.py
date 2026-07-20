import requests

r = requests.get('http://127.0.0.1:8000/events')
if r.status_code == 200:
    for ev in r.json():
        bf = ev.get('bounce_frame') or ev.get('metadata', {}).get('bounce_frame')
        csv_row = ev.get('csv_row') or ev.get('metadata', {}).get('csv_row')
        print(f"bounce_frame={bf} csv_row={csv_row} id={ev.get('id')}")
else:
    print(r.status_code)
