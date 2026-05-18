#!/usr/bin/env python3
import os
import time
import shutil
import threading
import argparse
import pandas as pd
from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
from contextlib import asynccontextmanager

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ASSIGNMENT_DIR = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(ASSIGNMENT_DIR, "sync_reports")
TEST_WORK_DIR = os.path.join(ASSIGNMENT_DIR, "test_work")

WINDOW_SIZE = 30
SPEED = 1.0

# Global state for sliding windows
server_state = {
    "source": {"media_sequence": 0, "window": [], "done": False, "current_index": 0},
    "sink":   {"media_sequence": 0, "window": [], "done": False, "current_index": 0},
    "hq":     {"media_sequence": 0, "window": [], "done": False, "current_index": 0},
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

def load_data():
    global events_data
    print("Loading CSVs into memory for O(1) lookups...")
    
    # 1. Load sync mapping
    sync_csv = os.path.join(DATA_DIR, "segments_1645", "sync", "hls_sync_1645_triple.csv")
    df_sync = pd.read_csv(sync_csv)
    for _, row in df_sync.iterrows():
        if pd.isna(row['Source_Index']) or pd.isna(row['Sink_Index']) or pd.isna(row['HQ_Index']):
            continue
            
        src_idx = int(row['Source_Index'])
        snk_idx = int(row['Sink_Index'])
        hq_idx = int(row['HQ_Index'])
        
        sync_maps["source_to_sink"][src_idx] = snk_idx
        sync_maps["source_to_hq"][src_idx] = hq_idx
        
        sync_maps["sink_to_source"][snk_idx] = src_idx
        sync_maps["sink_to_hq"][snk_idx] = hq_idx
        
        sync_maps["hq_to_source"][hq_idx] = src_idx
        sync_maps["hq_to_sink"][hq_idx] = snk_idx

    # 2. Load frame to segment mapping
    for cam in ["source", "sink", "hq"]:
        idx_csv = os.path.join(TEST_WORK_DIR, "cv_output", "reader", cam, "hls_segment_frame_index.csv")
        df_idx = pd.read_csv(idx_csv)
        
        for _, row in df_idx.iterrows():
            seg_idx = int(row['segment_index'])
            start_frame = int(row['cumulative_start_frame'])
            frame_count = int(row['frame_count'])
            
            seg_to_frame[cam][seg_idx] = start_frame
            for f in range(start_frame, start_frame + frame_count):
                frame_to_seg[cam][f] = (seg_idx, f - start_frame)
                
    # 3. Load events
    events_csv = os.path.join(TEST_WORK_DIR, "cv_output", "correlation", "flight_shots.csv")
    if os.path.exists(events_csv):
        df_events = pd.read_csv(events_csv)
        for _, row in df_events.iterrows():
            if pd.isna(row.get('bounce_hq_frame')):
                continue
            hq_frame = int(row['bounce_hq_frame'])
            if hq_frame in frame_to_seg["hq"]:
                seg, offset = frame_to_seg["hq"][hq_frame]
                time_offset = offset / FPS
                
                # Convert NaN to None for JSON compliance
                metadata = {}
                for k, v in row.items():
                    if pd.isna(v):
                        metadata[k] = None
                    else:
                        metadata[k] = v
                        
                events_data.append({
                    "id": str(row['shot_id']),
                    "hq_frame": hq_frame,
                    "hq_segment": seg,
                    "hq_offset": time_offset,
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
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:6",
        f"#EXT-X-MEDIA-SEQUENCE:{media_sequence}",
        "#EXT-X-ALLOW-CACHE:NO"
    ]
    for duration, name in window:
        lines.append(f"#EXTINF:{duration:.6f},")
        lines.append(name)
    if done:
        lines.append("#EXT-X-ENDLIST")
        
    temp_path = playlist_path + ".tmp"
    with open(temp_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.rename(temp_path, playlist_path)

def stream_worker(cam):
    source_dir = CAM_PATHS[cam]
    serve_dir = SERVE_DIRS[cam]
    for f in os.listdir(serve_dir):
        if f.endswith(".ts") or f.endswith(".m3u8"):
            try:
                os.remove(os.path.join(serve_dir, f))
            except:
                pass
    all_segs = parse_playlist(os.path.join(source_dir, "playlist.m3u8"))
    write_playlist(cam, [], 0)
    
    # Pre-fill the window so clients can start instantly
    initial_window = all_segs[:WINDOW_SIZE]
    released = []
    
    for duration, name in initial_window:
        released.append((duration, name))
        src = os.path.join(source_dir, name)
        dst = os.path.join(serve_dir, name)
        if not os.path.exists(dst) and os.path.exists(src):
            try: os.link(src, dst)
            except: shutil.copy2(src, dst)
            
    media_sequence = 0
    write_playlist(cam, released, media_sequence)
    
    # Loop indefinitely
    while True:
        for i in range(WINDOW_SIZE, len(all_segs)):
            duration, name = all_segs[i]
            released.append((duration, name))
            
            src = os.path.join(source_dir, name)
            dst = os.path.join(serve_dir, name)
            if not os.path.exists(dst) and os.path.exists(src):
                try: os.link(src, dst)
                except: shutil.copy2(src, dst)
                    
            if len(released) > WINDOW_SIZE:
                media_sequence += 1
                released = released[-WINDOW_SIZE:]
            window = released
            
            server_state[cam]["media_sequence"] = media_sequence
            server_state[cam]["window"] = window
            server_state[cam]["current_index"] = i
            server_state[cam]["done"] = False
            
            write_playlist(cam, window, media_sequence, False)
            time.sleep(duration / SPEED)
            
        # Wrap-around: Reset index and keep pushing segments continuously
        # Pre-fill is not needed since the window is already full and sliding forward!

@asynccontextmanager
async def lifespan(app: FastAPI):
    load_data()
    # Start stream workers
    for cam in ["source", "sink", "hq"]:
        t = threading.Thread(target=stream_worker, args=(cam,), daemon=True)
        t.start()
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

@app.get("/events")
def get_events():
    return events_data

@app.get("/status")
def get_status():
    return {
        cam: {
            "media_sequence": server_state[cam]["media_sequence"],
            "current_index": server_state[cam]["current_index"],
            "done": server_state[cam]["done"]
        } for cam in ["source", "sink", "hq"]
    }

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args()
    SPEED = args.speed
    print(f"Starting server on port {args.port} at {SPEED}x speed.")
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="error")
