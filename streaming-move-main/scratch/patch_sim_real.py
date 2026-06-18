import os

FILE_PATH = "tri_Stream_Server_sim_real.py"

with open(FILE_PATH, "r") as f:
    content = f.read()

# 1. Imports and args
content = content.replace(
"""import subprocess
import threading
import argparse
import urllib.request
import pandas as pd""", 
"""import subprocess
import threading
import argparse
import urllib.request
import json
import pandas as pd""")

content = content.replace(
"""_parser = argparse.ArgumentParser()
_parser.add_argument("--session", type=str, required=True, help="Session number, e.g. 1653")
_parser.add_argument("--port", type=int, default=8000)
_parser.add_argument("--speed", type=float, default=1.0)
_parser.add_argument("--cam-port", type=int, default=8083, help="Port of the live camera HLS streams")
_args = _parser.parse_args()

SESSION_ID = _args.session
SPEED = _args.speed
USE_BACKUP = True
CAM_PORT = _args.cam_port

IS_LIVE = False
START_TIME = time.time()
PRE_BUFFER = 12.0  # Matches sim_real.py fetching the last 3 segments on startup

JETSON_HOST = "jetson@192.168.0.148"
REMOTE_CSV_PATH = f"/home/jetson/Desktop/apr17/sync_reports/segments_{SESSION_ID}/sync/hls_sync_{SESSION_ID}_triple.csv"
FRAME_IDX_PATHS = {
    cam: f"/home/jetson/Desktop/cv_output/reader/{cam}/hls_segment_frame_index.csv"
    for cam in ["source", "sink", "hq"]
}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ASSIGNMENT_DIR = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(ASSIGNMENT_DIR, "sync_reports")
if not os.path.exists(DATA_DIR):
    DATA_DIR = os.path.join(ASSIGNMENT_DIR, "apr17", "sync_reports")
TEST_WORK_DIR = os.path.join(ASSIGNMENT_DIR, "test_work")""",
"""_parser = argparse.ArgumentParser()
_parser.add_argument(
    "--session", type=str, default=None,
    help="Override session ID (default: read counter from source Pi track_video_index.json)",
)
_parser.add_argument("--port", type=int, default=8000)
_parser.add_argument("--speed", type=float, default=1.0)
_parser.add_argument("--cam-port", type=int, default=8083, help="Port of the live camera HLS streams")
_parser.add_argument(
    "--source-pi-host",
    type=str,
    default="pi@192.168.0.111",
    help="SSH target for source Pi (track_video_index.json lives here)",
)
_args = _parser.parse_args()

SPEED = _args.speed
CAM_PORT = _args.cam_port

IS_LIVE = True
START_TIME = time.time()
PRE_BUFFER = 12.0  # Matches sim_real.py fetching the last 3 segments on startup

JETSON_HOST = "jetson@192.168.0.148"
SOURCE_PI_HOST = _args.source_pi_host
TRACK_VIDEO_INDEX_PATH = "/home/pi/source_code/variable_files/track_video_index.json"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ASSIGNMENT_DIR = os.path.dirname(BASE_DIR)
INTERN_DIR = os.path.dirname(ASSIGNMENT_DIR)
SSH_KEY_PATH = os.path.join(INTERN_DIR, "id_rsa")

def _ssh_argv(host, remote_cmd):
    return [
        "ssh",
        "-i", SSH_KEY_PATH,
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=2",
        "-o", "StrictHostKeyChecking=accept-new",
        host,
        remote_cmd,
    ]

def _fetch_session_from_source_pi():
    result = subprocess.run(
        _ssh_argv(SOURCE_PI_HOST, f"cat {TRACK_VIDEO_INDEX_PATH}"),
        capture_output=True, text=True, timeout=5,
    )
    result.check_returncode()
    data = json.loads(result.stdout.strip())
    return str(data["counter"])

def resolve_session_id():
    if _args.session:
        return str(_args.session)
    return _fetch_session_from_source_pi()

SESSION_ID = resolve_session_id()

REMOTE_CSV_PATH = f"/home/jetson/Desktop/apr17/sync_reports/segments_{SESSION_ID}/sync/hls_sync_{SESSION_ID}_triple.csv"
FRAME_IDX_PATHS = {
    cam: f"/home/jetson/Desktop/cv_output/reader/{cam}/hls_segment_frame_index.csv"
    for cam in ["source", "sink", "hq"]
}
DATA_DIR = os.path.join(ASSIGNMENT_DIR, "sync_reports")
if not os.path.exists(DATA_DIR):
    DATA_DIR = os.path.join(ASSIGNMENT_DIR, "apr17", "sync_reports")
TEST_WORK_DIR = os.path.join(ASSIGNMENT_DIR, "test_work")""")

# 2. Paths
content = content.replace(
"""# Paths
if not USE_BACKUP:
    CAM_PATHS = {
        "source": f"http://192.168.0.111:{CAM_PORT}/live.m3u8",
        "hq":     f"http://192.168.0.112:{CAM_PORT}/live.m3u8",
        "sink":   f"http://192.168.0.113:{CAM_PORT}/live.m3u8"
    }
else:
    CAM_PATHS = {
        "source": os.path.join(DATA_DIR, "ts_segments_source", SESSION_ID),
        "sink": os.path.join(DATA_DIR, "ts_segments_sink", SESSION_ID),
        "hq": os.path.join(DATA_DIR, "ts_segments_hq", SESSION_ID)
    }""",
"""# Paths
CAM_PATHS = {
    "source": f"http://192.168.0.111:{CAM_PORT}/live.m3u8",
    "hq":     f"http://192.168.0.112:{CAM_PORT}/live.m3u8",
    "sink":   f"http://192.168.0.113:{CAM_PORT}/live.m3u8"
}""")

# 3. _ssh_fetch real implementation
content = content.replace(
"""def _ssh_fetch(remote_path, skip_lines=0, delay_seconds=0):
    if "hls_sync" in remote_path:
        local_path = f"clips/sync_reports/segments_{SESSION_ID}/sync/hls_sync_{SESSION_ID}_triple.csv"
        frame_col = 0 # Source_Index is usually column 0
    elif "hls_segment_frame_index.csv" in remote_path:
        cam = "source"
        for c in ["source", "sink", "hq"]:
            if f"/{c}/" in remote_path or c in remote_path:
                cam = c
                break
        local_path = f"clips/cv_output/reader/{cam}/hls_segment_frame_index.csv"
        frame_col = 2 # cumulative_start_frame is column 2
    elif "flight_shots" in remote_path:
        local_path = f"clips/cv_output/correlation/flight_shots.csv"
        frame_col = 2 # end_frame is usually column 2
    else:
        raise ValueError(f"Unknown simulated remote path: {remote_path}")

    if not os.path.exists(local_path):
        raise FileNotFoundError(f"Local simulated file not found at: {local_path}")

    with open(local_path, "r") as f:
        lines = f.readlines()

    # Time-gate the lines based on simulated time, with optional delay
    sim_time = ((time.time() - START_TIME) * SPEED) + PRE_BUFFER - delay_seconds
    # Assuming the master camera is 'hq' at 30 fps
    max_frame = int(sim_time * FPS)
    
    # We always yield the header if it exists (usually line 0 is header)
    # But wait, flight_shots might not have header if skip_lines > 0?
    # In python string, if we slice, we should filter by the frame number.
    filtered_lines = []
    for i, line in enumerate(lines):
        if i == 0 and ("Index" in line or "frame" in line or "flight_id" in line):
            filtered_lines.append(line)
            continue
        
        parts = line.split(",")
        if len(parts) > frame_col:
            try:
                frame_val = float(parts[frame_col])
                if frame_val <= max_frame:
                    filtered_lines.append(line)
                else:
                    break # Since it's chronologically ordered, we can stop
            except ValueError:
                filtered_lines.append(line) # Fallback for unparseable

    if skip_lines == 0:
        return "".join(filtered_lines)
    else:
        return "".join(filtered_lines[skip_lines + 1:])


    if not os.path.exists(local_path):
        raise FileNotFoundError(f"Local simulated file not found at: {local_path}")

    with open(local_path, "r") as f:
        lines = f.readlines()

    if skip_lines == 0:
        return "".join(lines)
    else:
        return "".join(lines[skip_lines + 1:])""",
"""def _ssh_fetch(remote_path, skip_lines=0, allow_empty=False):
    try:
        remote_cmd = (f"cat {remote_path}" if skip_lines == 0
                      else f"tail -n +{skip_lines + 2} {remote_path} 2>/dev/null || true")
        result = subprocess.run(
            _ssh_argv(JETSON_HOST, remote_cmd),
            capture_output=True, text=True, timeout=4
        )
        if result.returncode != 0 and not allow_empty:
            result.check_returncode()
        return result.stdout
    except Exception as e:
        if allow_empty:
            return ""
        raise e

def _ssh_fetch_with_cmd(remote_cmd, allow_empty=False):
    try:
        result = subprocess.run(
            _ssh_argv(JETSON_HOST, remote_cmd),
            capture_output=True, text=True, timeout=4,
        )
        if result.returncode != 0 and not allow_empty:
            result.check_returncode()
        return result.stdout
    except Exception as e:
        if allow_empty:
            return ""
        raise e

def _fetch_flight_shots_csv(skip_data_rows=0):
    if skip_data_rows == 0:
        return _ssh_fetch(REMOTE_FLIGHT_SHOTS_PATH, skip_lines=0)
    remote_cmd = (
        f"(head -1 {REMOTE_FLIGHT_SHOTS_PATH}; "
        f"tail -n +{skip_data_rows + 2} {REMOTE_FLIGHT_SHOTS_PATH})"
    )
    return _ssh_fetch_with_cmd(remote_cmd)""")

# 4. _fetch_csv_lines
content = content.replace(
"""            new_text = _fetch_csv_lines(skip_lines=_sync_rows_loaded)""",
"""            new_text = _ssh_fetch(REMOTE_CSV_PATH, skip_lines=_sync_rows_loaded, allow_empty=True)""")

# 5. frame_idx_poller
content = content.replace(
"""                text = _ssh_fetch(FRAME_IDX_PATHS[cam], skip_lines=_frame_idx_rows[cam])""",
"""                text = _ssh_fetch(FRAME_IDX_PATHS[cam], skip_lines=_frame_idx_rows[cam], allow_empty=True)""")

# 6. flight_shots_poller
content = content.replace(
"""        try:
            text = _ssh_fetch(REMOTE_FLIGHT_SHOTS_PATH, skip_lines=_flight_shots_rows_loaded)
            added = _ingest_flight_shots(text, has_header=(_flight_shots_rows_loaded == 0))""",
"""        try:
            text = _fetch_flight_shots_csv(skip_data_rows=_flight_shots_rows_loaded)
            added = _ingest_flight_shots(text, has_header=(_flight_shots_rows_loaded == 0))""")

# 7. fetch initial flight shots
content = content.replace(
"""    try:
        csv_text = _ssh_fetch(REMOTE_FLIGHT_SHOTS_PATH, skip_lines=0)
        _flight_shots_rows_loaded = _ingest_flight_shots(csv_text, has_header=True)""",
"""    try:
        csv_text = _fetch_flight_shots_csv(skip_data_rows=0)
        _flight_shots_rows_loaded = _ingest_flight_shots(csv_text, has_header=True)""")

# 8. get_live_m3u8 and serve_segment and master worker removal
import re
# We just want to replace from "def get_live_m3u8" onwards.
# But also we need to remove the lifespan's master_stream_worker thread.
content = content.replace(
"""    threading.Thread(target=master_stream_worker, daemon=True).start()
""", "")

content = re.sub(r'def get_live_m3u8.*?def serve_segment.*?\n    return FileResponse\(dst\)', 
"""@app.get("/stream/{cam}/live.m3u8")
def get_live_m3u8(cam: str):
    from fastapi.responses import PlainTextResponse
    import os
    import urllib.request
    
    cam_path = CAM_PATHS.get(cam)
    if not cam_path:
        return PlainTextResponse("Camera not found", status_code=404)

    try:
        req = urllib.request.Request(cam_path, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            content = resp.read().decode("utf-8")
    except Exception as e:
        print(f"[get_live_m3u8] Error fetching {cam_path}: {e}")
        return PlainTextResponse("Failed to fetch live stream", status_code=502)

    lines = content.splitlines()
    header_lines = []
    segments = []

    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#EXTINF"):
            if i + 1 < len(lines):
                seg_line = lines[i+1]
                duration = float(line.split(":")[1].rstrip(","))
                segments.append((line, seg_line, duration))
                i += 2
                continue
        elif line.startswith("#EXT-X-ENDLIST"):
            i += 1
            continue
        else:
            header_lines.append(line)
        i += 1

    # In real scenario, the Pi's live.m3u8 is already a sliding window.
    # We proxy it but track eviction for logging parity.
    exposed_segments = [(inf, seg) for inf, seg, dur in segments]
    window_seg_names = {seg for inf, seg in exposed_segments}

    for inf, seg in exposed_segments:
        if seg in window_seg_names:
            if seg not in _logged_segments[cam]["loaded"]:
                print(f"[EVICTION LOGIC] Segment {seg} of {cam} loaded in server m3u8 playlist")
                _logged_segments[cam]["loaded"].add(seg)
    
    for loaded_seg in list(_logged_segments[cam]["loaded"]):
        if loaded_seg not in window_seg_names:
            if loaded_seg not in _logged_segments[cam]["removed"]:
                print(f"[EVICTION LOGIC] Segment {loaded_seg} of {cam} removed from server m3u8 playlist")
                _logged_segments[cam]["removed"].add(loaded_seg)

    out_lines = header_lines[:]
    for inf, seg in exposed_segments:
        out_lines.append(inf)
        out_lines.append(seg)
    return PlainTextResponse("\\n".join(out_lines), media_type="application/vnd.apple.mpegurl")

from fastapi.responses import FileResponse, StreamingResponse

@app.get("/stream/{cam}/{segment}.ts")
def serve_segment(cam: str, segment: str):
    from fastapi.responses import StreamingResponse, PlainTextResponse
    import urllib.request
    cam_path = CAM_PATHS.get(cam, "")
    if cam_path.startswith("http://") or cam_path.startswith("https://"):
        base_url = cam_path.rsplit('/', 1)[0]
        pi_url = f"{base_url}/{SESSION_ID}/{segment}.ts"
        try:
            req = urllib.request.Request(pi_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = resp.read()
            return StreamingResponse(
                iter([data]),
                media_type="video/mp2t",
                headers={"Cache-Control": "no-cache"}
            )
        except Exception as e:
            print(f"[serve_segment] Pi proxy fetch failed for {cam}/{segment}.ts: {e}")
            return PlainTextResponse(f"Segment not available on Pi: {e}", status_code=502)
    return PlainTextResponse("Camera path not found", status_code=404)""", content, flags=re.DOTALL)

with open(FILE_PATH, "w") as f:
    f.write(content)
