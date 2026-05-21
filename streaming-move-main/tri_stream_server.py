#!/usr/bin/env python3
import os
import io
import time
import shutil
import subprocess
import threading
import argparse
import pandas as pd
from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
from contextlib import asynccontextmanager

# Parse args at module level so SESSION_ID is available before lifespan runs
_parser = argparse.ArgumentParser()
_parser.add_argument("--session", type=str, required=True, help="Session number, e.g. 1653")
_parser.add_argument("--port", type=int, default=8000)
_parser.add_argument("--speed", type=float, default=1.0)
_args = _parser.parse_args()

SESSION_ID = _args.session
SPEED = _args.speed

JETSON_HOST = "jetson@192.168.0.148"
REMOTE_CSV_PATH = f"/home/jetson/Desktop/apr17/sync_reports/segments_{SESSION_ID}/sync/hls_sync_{SESSION_ID}_triple.csv"
FRAME_IDX_PATHS = {
    cam: f"/home/jetson/Desktop/cv_output/reader/{cam}/hls_segment_frame_index.csv"
    for cam in ["source", "sink", "hq"]
}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ASSIGNMENT_DIR = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(ASSIGNMENT_DIR, "sync_reports")
TEST_WORK_DIR = os.path.join(ASSIGNMENT_DIR, "test_work")

WINDOW_SIZE = 30

# Global state for sliding windows
server_state = {
    "source": {"media_sequence": 0, "window": [], "done": False, "current_index": 0, "is_gap": False},
    "sink":   {"media_sequence": 0, "window": [], "done": False, "current_index": 0, "is_gap": False},
    "hq":     {"media_sequence": 0, "window": [], "done": False, "current_index": 0, "is_gap": False},
}

# Pre-computed lookup tables
sync_maps = {
    "source_to_sink": {}, "source_to_hq": {},
    "sink_to_source": {}, "sink_to_hq": {},
    "hq_to_source": {}, "hq_to_sink": {}
}

# frame -> (seg_index, frame_offset)
frame_to_seg = { "source": {}, "sink": {}, "hq": {} }
seg_to_frame = { "source": {}, "sink": {}, "hq": {} } # seg_index -> cumulative_start_frame

# Paths
CAM_PATHS = {
    "source": os.path.join(DATA_DIR, "ts_segments_source", "1645"),
    "sink": os.path.join(DATA_DIR, "ts_segments_sink", "1645"),
    "hq": os.path.join(DATA_DIR, "ts_segments_hq", "1645")
}

SERVE_DIRS = {
    "source": os.path.join(BASE_DIR, "serve", "source"),
    "sink": os.path.join(BASE_DIR, "serve", "sink"),
    "hq": os.path.join(BASE_DIR, "serve", "hq")
}

events_data = []

FPS = 30.0

_sync_rows_loaded = 0  # number of data rows already ingested (excludes header)
_sync_lock = threading.Lock()

_frame_idx_rows = {"source": 0, "sink": 0, "hq": 0}
_frame_idx_lock = threading.Lock()

def _ssh_fetch(remote_path, skip_lines=0):
    """Fetch a file from the Jetson over SSH. skip_lines=0 → full file; N → only new rows after N data rows."""
    remote_cmd = (f"cat {remote_path}" if skip_lines == 0
                  else f"tail -n +{skip_lines + 2} {remote_path}")
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", JETSON_HOST, remote_cmd],
        capture_output=True, text=True, timeout=10
    )
    result.check_returncode()
    return result.stdout

def _fetch_csv_lines(skip_lines=0):
    return _ssh_fetch(REMOTE_CSV_PATH, skip_lines)

def _ingest_sync_rows(csv_text, has_header=True):
    """Parse csv_text and update sync_maps. Returns number of rows ingested."""
    if not csv_text.strip():
        return 0
    if has_header:
        df = pd.read_csv(io.StringIO(csv_text),
                         usecols=["Source_Index", "Sink_Index", "HQ_Index"])
    else:
        df = pd.read_csv(io.StringIO(csv_text), header=None, usecols=[0, 1, 2],
                         names=["Source_Index", "Sink_Index", "HQ_Index"])
    count = 0
    with _sync_lock:
        for _, row in df.iterrows():
            if pd.isna(row['Source_Index']) or pd.isna(row['Sink_Index']) or pd.isna(row['HQ_Index']):
                continue
            src_idx = int(row['Source_Index'])
            snk_idx = int(row['Sink_Index'])
            hq_idx  = int(row['HQ_Index'])
            sync_maps["source_to_sink"][src_idx] = snk_idx
            sync_maps["source_to_hq"][src_idx]   = hq_idx
            sync_maps["sink_to_source"][snk_idx]  = src_idx
            sync_maps["sink_to_hq"][snk_idx]      = hq_idx
            sync_maps["hq_to_source"][hq_idx]     = src_idx
            sync_maps["hq_to_sink"][hq_idx]       = snk_idx
            count += 1
    return count

def sync_csv_poller():
    """Background thread: polls the remote sync CSV every 4 s and ingests new rows."""
    global _sync_rows_loaded
    while True:
        time.sleep(4)
        try:
            new_text = _fetch_csv_lines(skip_lines=_sync_rows_loaded)
            added = _ingest_sync_rows(new_text, has_header=False)
            if added:
                _sync_rows_loaded += added
                print(f"[sync poller] +{added} new rows (total {_sync_rows_loaded})")
        except Exception as e:
            print(f"[sync poller] fetch error: {e}")

def _ingest_frame_idx_rows(cam, csv_text, has_header=True):
    """Parse frame index CSV text and update seg_to_frame / frame_to_seg. Returns rows added."""
    if not csv_text.strip():
        return 0
    # Columns: segment_index(0), seg_basename(1), cumulative_start_frame(2), frame_count(3)
    if has_header:
        df = pd.read_csv(io.StringIO(csv_text),
                         usecols=["segment_index", "cumulative_start_frame", "frame_count"])
    else:
        df = pd.read_csv(io.StringIO(csv_text), header=None, usecols=[0, 2, 3],
                         names=["segment_index", "cumulative_start_frame", "frame_count"])
    count = 0
    with _frame_idx_lock:
        for _, row in df.iterrows():
            seg_idx     = int(row["segment_index"])
            start_frame = int(row["cumulative_start_frame"])
            frame_count = int(row["frame_count"])
            seg_to_frame[cam][seg_idx] = start_frame
            for f in range(start_frame, start_frame + frame_count):
                frame_to_seg[cam][f] = (seg_idx, f - start_frame)
            count += 1
    return count

def frame_idx_poller():
    """Background thread: polls each camera's frame index CSV every 4 s for new segments."""
    global _frame_idx_rows
    while True:
        time.sleep(4)
        for cam in ["source", "sink", "hq"]:
            try:
                text = _ssh_fetch(FRAME_IDX_PATHS[cam], skip_lines=_frame_idx_rows[cam])
                added = _ingest_frame_idx_rows(cam, text, has_header=False)
                if added:
                    _frame_idx_rows[cam] += added
                    print(f"[frame idx poller] {cam} +{added} segs (total {_frame_idx_rows[cam]})")
            except Exception as e:
                print(f"[frame idx poller] {cam} error: {e}")

def load_data():
    global events_data, _sync_rows_loaded
    print("Loading CSVs into memory for O(1) lookups...")

    # 1. Load sync mapping from remote Jetson
    print(f"  Fetching remote sync CSV: {REMOTE_CSV_PATH}")
    csv_text = _fetch_csv_lines(skip_lines=0)
    _sync_rows_loaded = _ingest_sync_rows(csv_text, has_header=True)
    print(f"  Loaded {_sync_rows_loaded} sync rows from remote.")

    # 2. Load frame-to-segment index from remote Jetson
    for cam in ["source", "sink", "hq"]:
        print(f"  Fetching frame index [{cam}] from remote...")
        text = _ssh_fetch(FRAME_IDX_PATHS[cam])
        _frame_idx_rows[cam] = _ingest_frame_idx_rows(cam, text, has_header=True)
        print(f"  [{cam}] {_frame_idx_rows[cam]} segments, {len(frame_to_seg[cam])} frames indexed.")
                
    # 3. Load events
    events_csv = os.path.join(TEST_WORK_DIR, "cv_output", "correlation", "flight_shots.csv")
    if os.path.exists(events_csv):
        df_events = pd.read_csv(events_csv)
        for _, row in df_events.iterrows():
            if pd.isna(row.get('bounce_hq_frame')):
                continue
            hq_frame = int(row['bounce_hq_frame'])
            # Get source frame
            src_frame = sync_maps["hq_to_source"].get(hq_frame)
            if src_frame is None:
                if sync_maps["hq_to_source"]:
                    closest = min(sync_maps["hq_to_source"].keys(), key=lambda x: abs(x - hq_frame))
                    src_frame = sync_maps["hq_to_source"][closest]
                else:
                    src_frame = hq_frame
            
            # Get sink frame
            sink_frame = sync_maps["hq_to_sink"].get(hq_frame)
            if sink_frame is None:
                if sync_maps["hq_to_sink"]:
                    closest = min(sync_maps["hq_to_sink"].keys(), key=lambda x: abs(x - hq_frame))
                    sink_frame = sync_maps["hq_to_sink"][closest]
                else:
                    sink_frame = hq_frame
            
            # Map to segments and offsets for all cameras
            segs = {}
            offs = {}
            for cam, f_num in [("source", src_frame), ("sink", sink_frame), ("hq", hq_frame)]:
                if f_num in frame_to_seg[cam]:
                    c_seg, c_off = frame_to_seg[cam][f_num]
                    segs[cam] = c_seg
                    offs[cam] = c_off / FPS
                else:
                    # Fallback estimate
                    segs[cam] = int(f_num / 180) # 180 frames = 6s
                    offs[cam] = (f_num % 180) / FPS

            # Convert NaN to None for JSON compliance
            metadata = {}
            for k, v in row.items():
                if pd.isna(v):
                    metadata[k] = None
                else:
                    metadata[k] = v
                    
            events_data.append({
                "id": str(row['shot_id']),
                "segments": segs,
                "offsets": offs,
                "hq_frame": hq_frame,
                "metadata": metadata
            })
    print("Data loading complete.")

def parse_playlist(path):
    segments = []
    with open(path) as f:
        lines = f.read().splitlines()
    i = 0
    while i < len(lines):
        if lines[i].startswith("#EXTINF:"):
            duration = float(lines[i].split(":")[1].rstrip(","))
            seg = lines[i + 1].strip()
            segments.append((duration, seg))
            i += 2
        else:
            i += 1
    return segments

def write_playlist(cam, window, media_sequence, done=False):
    serve_dir = SERVE_DIRS[cam]
    playlist_path = os.path.join(serve_dir, "live.m3u8")
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:4",
        "#EXT-X-TARGETDURATION:6",
        f"#EXT-X-MEDIA-SEQUENCE:{media_sequence}",
        "#EXT-X-ALLOW-CACHE:NO"
    ]
    for item in window:
        if isinstance(item, str) and item == "#EXT-X-DISCONTINUITY":
            lines.append(item)
        elif isinstance(item, tuple) and len(item) == 3 and item[2] == "GAP":
            duration, name, _ = item
            lines.append("#EXT-X-DISCONTINUITY")
            lines.append(f"#EXTINF:{duration:.6f},")
            lines.append(name)
            lines.append("#EXT-X-DISCONTINUITY")
        else:
            duration, name = item
            lines.append(f"#EXTINF:{duration:.6f},")
            lines.append(name)
    if done:
        lines.append("#EXT-X-ENDLIST")
        
    temp_path = playlist_path + ".tmp"
    with open(temp_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.rename(temp_path, playlist_path)

def master_stream_worker():
    # Clean serve dirs
    for cam in ["source", "sink", "hq"]:
        serve_dir = SERVE_DIRS[cam]
        for f in os.listdir(serve_dir):
            if f.endswith(".ts") or f.endswith(".m3u8"):
                try: os.remove(os.path.join(serve_dir, f))
                except: pass
                
    # Parse all playlists
    all_segs = {}
    for cam in ["source", "sink", "hq"]:
        all_segs[cam] = parse_playlist(os.path.join(CAM_PATHS[cam], "playlist.m3u8"))
        
        # Create a gap filler video for this camera using its first segment
        if len(all_segs[cam]) > 0:
            first_seg = all_segs[cam][0][1]
            first_src = os.path.join(CAM_PATHS[cam], first_seg)
            gap_dst = os.path.join(SERVE_DIRS[cam], f"gap_{cam}.ts")
            if not os.path.exists(gap_dst) and os.path.exists(first_src):
                try: os.link(first_src, gap_dst)
                except: shutil.copy2(first_src, gap_dst)
            
    released = {"source": [], "sink": [], "hq": []}
    media_sequence = {"source": 0, "sink": 0, "hq": 0}
    
    hq_segs = all_segs["hq"]
    max_len = len(hq_segs)
    current_idx = 0
    
    # Pre-build timeline map for fast iteration
    # Since HQ is perfectly contiguous (no missing internal segments), it is our Master Clock.
    timeline = []
    prev_seg = {"source": -1, "sink": -1}
    for hq_idx in range(max_len):
        hq_dur, hq_name = hq_segs[hq_idx]
        hq_start_frame = seg_to_frame["hq"].get(hq_idx)
        
        row = {"hq": (hq_dur, hq_name), "source": None, "sink": None}
        
        for cam in ["source", "sink"]:
            map_key = f"hq_to_{cam}"
            target_f = None
            if hq_start_frame is not None:
                if hq_start_frame in sync_maps[map_key]:
                    target_f = sync_maps[map_key][hq_start_frame]
                elif sync_maps[map_key]:
                    closest = min(sync_maps[map_key].keys(), key=lambda x: abs(x - hq_start_frame))
                    # Reduce from 500 to 120 so we don't repeat frames across long gaps
                    if abs(closest - hq_start_frame) < 120:
                        target_f = sync_maps[map_key][closest]
            
            if target_f is not None and target_f in frame_to_seg[cam]:
                cam_seg_idx = frame_to_seg[cam][target_f][0]
                
                # Check if we are incorrectly repeating a segment which freezes the player
                # If the camera hasn't advanced, we emit a GAP!
                if cam_seg_idx != prev_seg[cam] and cam_seg_idx < len(all_segs[cam]):
                    row[cam] = all_segs[cam][cam_seg_idx]
                    prev_seg[cam] = cam_seg_idx
                else:
                    row[cam] = (hq_dur, f"gap_{cam}.ts", "GAP")
            else:
                row[cam] = (hq_dur, f"gap_{cam}.ts", "GAP")
                
        timeline.append(row)
    
    while True:
        # Loop wrap around
        if current_idx >= max_len:
            current_idx = 0
            for cam in ["source", "sink", "hq"]:
                released[cam].append("#EXT-X-DISCONTINUITY")
        
        step_duration = timeline[current_idx]["hq"][0]
        
        for cam in ["source", "sink", "hq"]:
            item = timeline[current_idx][cam]
            released[cam].append(item)
            
            is_gap_item = (isinstance(item, tuple) and len(item) == 3 and item[2] == "GAP")
            server_state[cam]["is_gap"] = is_gap_item

            if len(item) == 2: # Physical file
                name = item[1]
                src = os.path.join(CAM_PATHS[cam], name)
                dst = os.path.join(SERVE_DIRS[cam], name)
                if not os.path.exists(dst) and os.path.exists(src):
                    try: os.link(src, dst)
                    except: shutil.copy2(src, dst)
                    
        # Manage sliding window and write playlists
        for cam in ["source", "sink", "hq"]:
            media_items_count = sum(1 for x in released[cam] if isinstance(x, tuple))
            while media_items_count > WINDOW_SIZE:
                popped = released[cam].pop(0)
                if isinstance(popped, tuple):
                    media_items_count -= 1
                    media_sequence[cam] += 1
            
            server_state[cam]["media_sequence"] = media_sequence[cam]
            server_state[cam]["window"] = [x for x in released[cam] if isinstance(x, tuple)]
            server_state[cam]["current_index"] = current_idx
            
            write_playlist(cam, released[cam], media_sequence[cam], False)

        if step_duration == 0:
            step_duration = 4.0
        time.sleep(step_duration / SPEED)
        current_idx += 1

@asynccontextmanager
async def lifespan(app: FastAPI):
    load_data()
    threading.Thread(target=master_stream_worker, daemon=True).start()
    threading.Thread(target=sync_csv_poller, daemon=True).start()
    threading.Thread(target=frame_idx_poller, daemon=True).start()
    yield

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Mount static files for the streams (Port 8000 will serve them all, much cleaner than 3 separate ports!)
# The requirement "Suggested ports: 8081 -> SOURCE..." is a suggestion. 
# It is vastly more stable and clean to serve them via FastAPI static mounting on different routes.
for d in SERVE_DIRS.values():
    os.makedirs(d, exist_ok=True)

app.mount("/stream/source", StaticFiles(directory=os.path.join(BASE_DIR, "serve", "source")), name="source")
app.mount("/stream/sink", StaticFiles(directory=os.path.join(BASE_DIR, "serve", "sink")), name="sink")
app.mount("/stream/hq", StaticFiles(directory=os.path.join(BASE_DIR, "serve", "hq")), name="hq")

# For the bounce clips
BOUNCE_CLIPS_DIR = os.path.join(ASSIGNMENT_DIR, "bounce_clips_share")
if os.path.exists(BOUNCE_CLIPS_DIR):
    app.mount("/clips", StaticFiles(directory=BOUNCE_CLIPS_DIR), name="clips")

@app.get("/cameras")
def get_cameras():
    return {
        "source": "http://localhost:8000/stream/source/live.m3u8",
        "sink": "http://localhost:8000/stream/sink/live.m3u8",
        "hq": "http://localhost:8000/stream/hq/live.m3u8"
    }

@app.get("/sync")
def get_sync(from_camera: str, from_seg: int, from_offset: float):
    # Calculate absolute frame
    if from_seg not in seg_to_frame[from_camera]:
        return JSONResponse(status_code=404, content={"error": "Segment not found in index"})
        
    start_frame = seg_to_frame[from_camera][from_seg]
    current_frame = start_frame + int(from_offset * FPS)
    
    # We might ask for a frame slightly outside the range, clamp to closest available
    available_frames = list(frame_to_seg[from_camera].keys())
    if current_frame not in frame_to_seg[from_camera]:
        current_frame = min(available_frames, key=lambda x: abs(x - current_frame))

    # Get corresponding frames
    res = {}
    for target_cam in ["source", "sink", "hq"]:
        if target_cam == from_camera:
            res[target_cam] = {"segment": from_seg, "offset": from_offset}
            continue
            
        map_key = f"{from_camera}_to_{target_cam}"
        if current_frame in sync_maps[map_key]:
            target_frame = sync_maps[map_key][current_frame]
        else:
            # Fallback if frame dropped/missing from sync map: just pick the closest
            closest = min(sync_maps[map_key].keys(), key=lambda x: abs(x - current_frame))
            target_frame = sync_maps[map_key][closest]
            
        if target_frame not in frame_to_seg[target_cam]:
            available = list(frame_to_seg[target_cam].keys())
            target_frame = min(available, key=lambda x: abs(x - target_frame))
            
        t_seg, t_frame_offset = frame_to_seg[target_cam][target_frame]
        res[target_cam] = {
            "segment": t_seg,
            "offset": t_frame_offset / FPS
        }
        
    return res

@app.get("/sync_map")
def get_sync_map(from_camera: str, sns: str):
    # sns is a comma-separated list of segment sequence numbers
    try:
        sn_list = [int(x) for x in sns.split(",") if x.strip()]
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "Invalid sns parameter"})
        
    res = {}
    for sn in sn_list:
        if sn not in seg_to_frame[from_camera]:
            continue
        start_frame = seg_to_frame[from_camera][sn]
        
        # Get corresponding frames at the start of this segment
        seg_res = {}
        for target_cam in ["source", "sink", "hq"]:
            if target_cam == from_camera:
                seg_res[target_cam] = {"segment": sn, "offset": 0.0}
                continue
                
            map_key = f"{from_camera}_to_{target_cam}"
            if start_frame in sync_maps[map_key]:
                target_frame = sync_maps[map_key][start_frame]
            else:
                closest = min(sync_maps[map_key].keys(), key=lambda x: abs(x - start_frame))
                target_frame = sync_maps[map_key][closest]
                
            if target_frame not in frame_to_seg[target_cam]:
                available = list(frame_to_seg[target_cam].keys())
                target_frame = min(available, key=lambda x: abs(x - target_frame))
                
            t_seg, t_frame_offset = frame_to_seg[target_cam][target_frame]
            seg_res[target_cam] = {
                "segment": t_seg,
                "offset": t_frame_offset / FPS
            }
        res[sn] = seg_res
    return res

@app.get("/check_sync")
def check_sync(
    source_seg: int = 0, source_off: float = 0.0,
    sink_seg:   int = 0, sink_off:   float = 0.0,
    hq_seg:     int = 0, hq_off:     float = 0.0,
    tolerance:  int = 15
):
    positions = {"source": (source_seg, source_off), "sink": (sink_seg, sink_off), "hq": (hq_seg, hq_off)}

    # Convert seg+offset → absolute frame for each camera
    frames = {}
    for cam, (seg, off) in positions.items():
        if seg in seg_to_frame[cam]:
            frames[cam] = seg_to_frame[cam][seg] + int(off * FPS)
        else:
            frames[cam] = None

    # For each (anchor, target) pair, check CSV prediction vs actual target frame
    pairs = [("source", "sink"), ("source", "hq"), ("sink", "hq")]
    checks = {}
    with _sync_lock:
        for anchor, target in pairs:
            key = f"{anchor}_to_{target}"
            if frames[anchor] is None or frames[target] is None:
                checks[key] = {"error": "frame index missing", "match": False}
                continue
            anchor_frame = frames[anchor]
            # Step 1: raw expected frame from sync map
            if anchor_frame in sync_maps[key]:
                raw_expected = sync_maps[key][anchor_frame]
                exact = True
            elif sync_maps[key]:
                closest = min(sync_maps[key].keys(), key=lambda x: abs(x - anchor_frame))
                raw_expected = sync_maps[key][closest]
                exact = False
            else:
                checks[key] = {"error": "sync map empty", "match": False}
                continue
            # Step 2: clamp raw_expected to nearest valid frame in target's frame index
            # (same correction /sync uses — handles 1:1 maps that go out of range)
            if raw_expected in frame_to_seg[target]:
                expected = raw_expected
            elif frame_to_seg[target]:
                expected = min(frame_to_seg[target].keys(), key=lambda x: abs(x - raw_expected))
            else:
                checks[key] = {"error": "frame index empty for target", "match": False}
                continue
            diff = abs(frames[target] - expected)
            checks[key] = {
                "anchor_frame": anchor_frame,
                "expected_target_frame": expected,
                "actual_target_frame": frames[target],
                "diff_frames": diff,
                "exact_hit": exact,
                "match": diff <= tolerance,
            }

    overall = all(c.get("match", False) for c in checks.values())
    return {"frames": frames, "checks": checks, "overall_match": overall, "tolerance": tolerance}

@app.get("/events")
def get_events():
    return events_data

@app.get("/status")
def get_status():
    return {
        cam: {
            "media_sequence": server_state[cam]["media_sequence"],
            "current_index": server_state[cam]["current_index"],
            "done": server_state[cam]["done"],
            "is_gap": server_state[cam]["is_gap"]
        } for cam in ["source", "sink", "hq"]
    }

if __name__ == "__main__":
    print(f"Starting server on port {_args.port} at {SPEED}x speed (session {SESSION_ID}).")
    uvicorn.run(app, host="0.0.0.0", port=_args.port, log_level="error")
