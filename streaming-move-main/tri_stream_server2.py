#!/usr/bin/env python3
import os
import io
import time
import shutil
import subprocess
import threading
import argparse
import urllib.request
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
_parser.add_argument("--backup", action="store_true", help="Use local fallback folders if live ports fail")
_parser.add_argument("--cam-port", type=int, default=8083, help="Port of the live camera HLS streams")
_args = _parser.parse_args()

SESSION_ID = _args.session
SPEED = _args.speed
USE_BACKUP = _args.backup
CAM_PORT = _args.cam_port

IS_LIVE = not USE_BACKUP

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
seg_frame_count = { "source": {}, "sink": {}, "hq": {} } # seg_index -> frame_count

# Paths
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

def _fetch_local_fallback(remote_path, skip_lines=0):
    if "hls_sync" in remote_path:
        local_path = f"/Users/aryamirani/Desktop/intern/judex/ssh/sync_reports/segments_{SESSION_ID}/sync/hls_sync_{SESSION_ID}_triple.csv"
    elif "hls_segment_frame_index.csv" in remote_path:
        cam = None
        for c in ["source", "sink", "hq"]:
            if f"/{c}/" in remote_path or c in remote_path:
                cam = c
                break
        if cam is None:
            cam = "source"
        local_path = f"/Users/aryamirani/Desktop/intern/judex/ssh/test_work/cv_output/reader/{cam}/hls_segment_frame_index.csv"
    else:
        raise ValueError(f"Unknown remote path: {remote_path}")

    if not os.path.exists(local_path):
        raise FileNotFoundError(f"Local fallback file not found at: {local_path}")

    with open(local_path, "r") as f:
        lines = f.readlines()

    if skip_lines == 0:
        return "".join(lines)
    else:
        return "".join(lines[skip_lines + 1:])

def _ssh_fetch(remote_path, skip_lines=0):
    """Fetch a file from the Jetson over SSH. If it fails, fall back to local files."""
    if USE_BACKUP:
        return _fetch_local_fallback(remote_path, skip_lines)
    try:
        remote_cmd = (f"cat {remote_path}" if skip_lines == 0
                      else f"tail -n +{skip_lines + 2} {remote_path}")
        result = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=2", JETSON_HOST, remote_cmd],
            capture_output=True, text=True, timeout=4
        )
        result.check_returncode()
        return result.stdout
    except Exception as e:
        print(f"  [X] SSH fetch failed: {e}. (No --backup flag provided, so failing explicitly)")
        raise e

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
    """
    Background thread: polls the remote sync CSV every 1 second and ingests new rows.
    """
    global _sync_rows_loaded
    while True:
        time.sleep(4)
        try:
            new_text = _fetch_csv_lines(skip_lines=_sync_rows_loaded)
            added = _ingest_sync_rows(new_text, has_header=(_sync_rows_loaded == 0))
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
            seg_frame_count[cam][seg_idx] = frame_count
            for f in range(start_frame, start_frame + frame_count):
                frame_to_seg[cam][f] = (seg_idx, f - start_frame)
            count += 1
    return count

def frame_idx_poller():
    """Background thread: polls each camera's frame index CSV every 2 s for new segments."""
    global _frame_idx_rows
    while True:
        time.sleep(2)
        for cam in ["source", "sink", "hq"]:
            try:
                text = _ssh_fetch(FRAME_IDX_PATHS[cam], skip_lines=_frame_idx_rows[cam])
                added = _ingest_frame_idx_rows(cam, text, has_header=(_frame_idx_rows[cam] == 0))
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

def fetch_playlist_content(path_or_url):
    if path_or_url.startswith("http://") or path_or_url.startswith("https://"):
        req = urllib.request.Request(path_or_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.read().decode('utf-8')
    else:
        with open(path_or_url) as f:
            return f.read()

def parse_playlist(path_or_url):
    segments = []
    has_endlist = False
    try:
        content = fetch_playlist_content(path_or_url)
        lines = content.splitlines()
    except Exception as e:
        print(f"[parse_playlist] Error reading {path_or_url}: {e}")
        return segments, has_endlist
        
    i = 0
    while i < len(lines):
        if lines[i].startswith("#EXT-X-ENDLIST"):
            has_endlist = True
            i += 1
        elif lines[i].startswith("#EXTINF:"):
            duration = float(lines[i].split(":")[1].rstrip(","))
            seg = lines[i + 1].strip()
            segments.append((duration, seg))
            i += 2
        else:
            i += 1
    return segments, has_endlist

def write_playlist(cam, window, media_sequence, done=False):
    import math
    serve_dir = SERVE_DIRS[cam]
    playlist_path = os.path.join(serve_dir, "live.m3u8")
    
    target_dur = 6
    for item in window:
        if isinstance(item, dict):
            target_dur = max(target_dur, math.ceil(item["dur_global"]))
            
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:4",
        f"#EXT-X-TARGETDURATION:{target_dur}",
        f"#EXT-X-MEDIA-SEQUENCE:{media_sequence}",
        "#EXT-X-ALLOW-CACHE:NO",
        "#EXT-X-START:TIME-OFFSET=-4.0"
    ]
    for item in window:
        if isinstance(item, str) and item == "#EXT-X-DISCONTINUITY":
            lines.append(item)
        elif isinstance(item, dict):
            dur = item["dur_global"]
            orig_dur = item.get("orig_durs", {}).get(cam, dur) if "orig_durs" in item else item.get("orig_dur", dur)
            name = item["name"]
            
            if name and orig_dur > 0 and (dur - orig_dur) > 0.5:
                # Add original duration and segment
                lines.append(f"#EXTINF:{orig_dur:.6f},")
                lines.append(name)
                # Explicit gap to cover the rest of the time
                lines.append("#EXT-X-DISCONTINUITY")
                lines.append(f"#EXTINF:{(dur - orig_dur):.6f},")
                lines.append("#EXT-X-GAP")
                lines.append("gap.ts")
            elif name is not None:
                lines.append(f"#EXTINF:{dur:.6f},")
                lines.append(name)
            else:
                # Name is None (segment is missing/camera offline)
                lines.append("#EXT-X-DISCONTINUITY")
                lines.append(f"#EXTINF:{dur:.6f},")
                lines.append("#EXT-X-GAP")
                lines.append("gap.ts")
    if done:
        lines.append("#EXT-X-ENDLIST")
        
    temp_path = playlist_path + ".tmp"
    with open(temp_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.rename(temp_path, playlist_path)

_active_downloads = set()
_downloads_lock = threading.Lock()

def get_global_time(cam, frame):
    if cam == "source":
        return frame / FPS
    map_key = f"{cam}_to_source"
    
    with _sync_lock:
        if not sync_maps[map_key]:
            return frame / FPS
            
        if frame in sync_maps[map_key]:
            return sync_maps[map_key][frame] / FPS
            
        keys = sorted(sync_maps[map_key].keys())
        import bisect
        idx = bisect.bisect_left(keys, frame)
        if idx == 0:
            ref_f = keys[0]
            diff = frame - ref_f
            return (sync_maps[map_key][ref_f] + diff) / FPS
        elif idx == len(keys):
            ref_f = keys[-1]
            diff = frame - ref_f
            return (sync_maps[map_key][ref_f] + diff) / FPS
        else:
            f1 = keys[idx-1]
            f2 = keys[idx]
            s1 = sync_maps[map_key][f1]
            s2 = sync_maps[map_key][f2]
            ratio = (frame - f1) / (f2 - f1)
            mapped_frame = s1 + ratio * (s2 - s1)
            return mapped_frame / FPS

def get_segment_start_frame(cam, abs_idx):
    with _frame_idx_lock:
        if abs_idx in seg_to_frame[cam]:
            return seg_to_frame[cam][abs_idx]
        keys = sorted(seg_to_frame[cam].keys())
        if not keys:
            return abs_idx * 180
        closest_seg = min(keys, key=lambda x: abs(x - abs_idx))
        return seg_to_frame[cam][closest_seg] + (abs_idx - closest_seg) * 180

def parse_abs_seg_idx(name):
    if not name:
        return None
    import re
    base = os.path.basename(name)
    m = re.search(r'(\d+)\.ts$', base)
    if m:
        return int(m.group(1))
    return None

def download_segment_file(src_url, dst, cam, name):
    try:
        if os.path.exists(dst):
            return
        req = urllib.request.Request(src_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=3) as response:
            temp_dst = dst + ".tmp"
            with open(temp_dst, "wb") as f_dst:
                f_dst.write(response.read())
            os.rename(temp_dst, dst)
        print(f"[master worker] Downloaded segment {name} from {src_url}")
    except Exception as e:
        print(f"[master worker] Error downloading {src_url}: {e}")
        # Fallback to backup
        if USE_BACKUP:
            backup_src = f"/Users/aryamirani/Desktop/intern/judex/ssh/sync_reports/ts_segments_{cam}/{SESSION_ID}/{name}"
            if os.path.exists(backup_src):
                try:
                    temp_dst = dst + ".tmp"
                    shutil.copy2(backup_src, temp_dst)
                    os.rename(temp_dst, dst)
                    print(f"[master worker] Recovered {name} from backup")
                except Exception as backup_err:
                    print(f"[master worker] Backup recovery failed: {backup_err}")
    finally:
        with _downloads_lock:
            _active_downloads.discard(dst)

def master_stream_worker():
    # Clean serve dirs recursively
    for cam in ["source", "sink", "hq"]:
        serve_dir = SERVE_DIRS[cam]
        if os.path.exists(serve_dir):
            try: shutil.rmtree(serve_dir)
            except: pass
        os.makedirs(serve_dir, exist_ok=True)
                
    # Parse all playlists
    all_segs = {}
    playlists_ended = {}
    for cam in ["source", "sink", "hq"]:
        cam_path = CAM_PATHS[cam]
        segs, ended = [], False
        if cam_path.startswith("http://") or cam_path.startswith("https://"):
            playlist_path = cam_path
            try:
                segs, ended = parse_playlist(playlist_path)
            except Exception as e:
                print(f"[master worker] Initial playlist fetch error for {cam}: {e}")
            if not segs and USE_BACKUP:
                    backup_playlist = f"/Users/aryamirani/Desktop/intern/judex/ssh/sync_reports/ts_segments_{cam}/{SESSION_ID}/playlist.m3u8"
                    if os.path.exists(backup_playlist):
                        playlist_path = backup_playlist
                        try:
                            segs, ended = parse_playlist(playlist_path)
                        except Exception as e:
                            print(f"[master worker] Initial fallback playlist parse error for {cam}: {e}")
        else:
            playlist_path = os.path.join(cam_path, "playlist.m3u8")
            if not os.path.exists(playlist_path):
                backup_playlist = f"/Users/aryamirani/Desktop/intern/judex/ssh/sync_reports/ts_segments_{cam}/{SESSION_ID}/playlist.m3u8"
                if os.path.exists(backup_playlist):
                    playlist_path = backup_playlist
            if os.path.exists(playlist_path):
                try:
                    segs, ended = parse_playlist(playlist_path)
                except Exception as e:
                    print(f"[master worker] Initial local playlist parse error for {cam}: {e}")
        all_segs[cam] = segs
        playlists_ended[cam] = ended
        
    seen_segs = {"source": set(), "sink": set(), "hq": set()}
    for cam in ["source", "sink", "hq"]:
        for item in all_segs[cam]:
            seen_segs[cam].add(item[1])
        
    released = {"source": [], "sink": [], "hq": []}
    media_sequence = {"source": 0, "sink": 0, "hq": 0}
    
    # Unified Timeline state
    unified_steps = []
    next_step_idx = 0
    
    def update_unified_timeline():
        nonlocal unified_steps
        unified_steps = unified_steps[:next_step_idx]
        
        # Iterate over source segments
        max_segs = max(len(all_segs[cam]) for cam in ["source", "sink", "hq"])
        while len(unified_steps) < max_segs:
            src_seg_idx = len(unified_steps)
            if src_seg_idx < len(all_segs["source"]):
                src_dur, src_name = all_segs["source"][src_seg_idx]
                src_abs_idx = parse_abs_seg_idx(src_name)
                src_start_frame = None
                if src_abs_idx is not None:
                    src_start_frame = seg_to_frame["source"].get(src_abs_idx)
            else:
                src_dur, src_name = 0.0, None
                src_abs_idx = None
                src_start_frame = None
            seg_indices = {}
            durs = {}
            names = {}
            
            for cam in ["source", "sink", "hq"]:
                if cam == "source":
                    seg_idx_cam = src_seg_idx
                else:
                    map_key = f"source_to_{cam}"
                    target_f = None
                    if src_start_frame is not None:
                        if src_start_frame in sync_maps[map_key]:
                            target_f = sync_maps[map_key][src_start_frame]
                        elif sync_maps[map_key]:
                            closest = min(sync_maps[map_key].keys(), key=lambda x: abs(x - src_start_frame))
                            target_f = sync_maps[map_key][closest]
                    
                    if target_f is not None and target_f in frame_to_seg[cam]:
                        mapped_abs_idx = frame_to_seg[cam][target_f][0]
                        mapped_list_idx = None
                        for i, item in enumerate(all_segs[cam]):
                            if parse_abs_seg_idx(item[1]) == mapped_abs_idx:
                                mapped_list_idx = i
                                break
                        if mapped_list_idx is not None:
                            prev = -1 if not unified_steps else unified_steps[-1]["seg_indices"][cam]
                            seg_idx_cam = max(mapped_list_idx, prev + 1 if prev != -1 else mapped_list_idx)
                        else:
                            prev = -1 if not unified_steps else unified_steps[-1]["seg_indices"][cam]
                            seg_idx_cam = prev + 1 if prev != -1 else src_seg_idx
                    else:
                        prev = -1 if not unified_steps else unified_steps[-1]["seg_indices"][cam]
                        seg_idx_cam = prev + 1 if prev != -1 else src_seg_idx
                        
                seg_indices[cam] = seg_idx_cam
                if seg_idx_cam < len(all_segs[cam]):
                    durs[cam] = all_segs[cam][seg_idx_cam][0]
                    names[cam] = all_segs[cam][seg_idx_cam][1]
                else:
                    durs[cam] = 0.0
                    names[cam] = None
                    
            t_start = 0.0
            if src_start_frame is not None:
                t_start = src_start_frame / 30.0
            elif unified_steps:
                t_start = unified_steps[-1]["t_start"] + unified_steps[-1]["dur_global"]
                
            if all(name is None for name in names.values()):
                break

                
            unified_steps.append({
                "seg_indices": seg_indices,
                "names": names,
                "orig_durs": durs,
                "t_start": t_start,
                "dur_global": 4.0
            })
            
        for i in range(len(unified_steps) - 1):
            unified_steps[i]["dur_global"] = unified_steps[i+1]["t_start"] - unified_steps[i]["t_start"]
            
        if unified_steps:
            last_step = unified_steps[-1]
            max_fc = 0
            for cam, n in last_step["names"].items():
                if n is not None:
                    abs_idx_cam = parse_abs_seg_idx(n)
                    fc = seg_frame_count[cam].get(abs_idx_cam) if abs_idx_cam is not None else None
                    if fc and fc > max_fc:
                        max_fc = fc
            if max_fc > 0:
                last_step["dur_global"] = max_fc / 30.0
            else:
                last_step["dur_global"] = max(last_step["orig_durs"].values()) if any(last_step["orig_durs"].values()) else 4.0

    update_unified_timeline()
    
    def get_total_duration():
        if unified_steps:
            last = unified_steps[-1]
            return last["t_start"] + last["dur_global"]
        return 0.0
        
    total_duration = get_total_duration()
    
    start_time = time.time()
    last_time = start_time
    target_sim_time = max(0.0, total_duration - 8.0) if IS_LIVE else 0.0
    stream_done = False
    last_playlist_poll = 0.0
    
    while True:
        now = time.time()
        dt = (now - last_time) * SPEED
        last_time = now
        
        # 1. Periodically check playlists
        if now - last_playlist_poll >= 4.0:
            last_playlist_poll = now
            
            updated_segs = {}
            updated_ended = {}
            grew = False
            for cam in ["source", "sink", "hq"]:
                cam_path = CAM_PATHS[cam]
                segs, ended = [], False
                success = False
                
                if cam_path.startswith("http://") or cam_path.startswith("https://"):
                    playlist_path = cam_path
                    try:
                        segs, ended = parse_playlist(playlist_path)
                        if segs:
                            success = True
                    except Exception as e:
                        print(f"[master worker] Error polling live playlist for {cam}: {e}")
                    
                    if not success:
                        backup_playlist = f"/Users/aryamirani/Desktop/intern/judex/ssh/sync_reports/ts_segments_{cam}/{SESSION_ID}/playlist.m3u8"
                        if os.path.exists(backup_playlist):
                            try:
                                segs, ended = parse_playlist(backup_playlist)
                                success = True
                            except Exception as e:
                                print(f"[master worker] Error polling backup playlist for {cam}: {e}")
                else:
                    playlist_path = os.path.join(cam_path, "playlist.m3u8")
                    if not os.path.exists(playlist_path):
                        backup_playlist = f"/Users/aryamirani/Desktop/intern/judex/ssh/sync_reports/ts_segments_{cam}/{SESSION_ID}/playlist.m3u8"
                        if os.path.exists(backup_playlist):
                            playlist_path = backup_playlist
                    
                    if os.path.exists(playlist_path):
                        try:
                            segs, ended = parse_playlist(playlist_path)
                            success = True
                        except Exception as e:
                            print(f"[master worker] Error polling local playlist for {cam}: {e}")
                
                if success:
                    updated_segs[cam] = segs
                    updated_ended[cam] = ended
                else:
                    updated_segs[cam] = all_segs[cam]
                    updated_ended[cam] = playlists_ended.get(cam, False)
            
            for cam in ["source", "sink", "hq"]:
                playlists_ended[cam] = updated_ended[cam]
                new_items = [item for item in updated_segs[cam] if item[1] not in seen_segs[cam]]
                if new_items:
                    for item in new_items:
                        seen_segs[cam].add(item[1])
                    all_segs[cam].extend(new_items)
                    print(f"[master worker] Camera {cam} playlist grew by {len(new_items)} segments. Total: {len(all_segs[cam])}")
                    grew = True
                    
            if grew:
                update_unified_timeline()
                total_duration = get_total_duration()
        
        # Update current target simulation time
        if not stream_done:
            has_endlist = playlists_ended.get("hq", False)
            if target_sim_time < total_duration:
                target_sim_time += dt
                if target_sim_time > total_duration:
                    target_sim_time = total_duration
            
            # Catch up check
            if IS_LIVE and (total_duration - target_sim_time > 15.0):
                print(f"[master worker] Live stream lag detected ({total_duration - target_sim_time:.1f}s). Jumping to live edge.")
                target_sim_time = max(0.0, total_duration - 8.0)
            
            if target_sim_time >= total_duration and has_endlist:
                stream_done = True
                print("[master worker] Stream complete. Stopping at the end.")
        
        # Release unified segments based on target_sim_time
        while next_step_idx < len(unified_steps) and unified_steps[next_step_idx]["t_start"] <= target_sim_time:
            step = unified_steps[next_step_idx]
            
            for cam in ["source", "sink", "hq"]:
                name = step["names"][cam]
                if name is not None:
                    # Release actual segment
                    seg = {
                        "name": name,
                        "dur_global": step["dur_global"],
                        "orig_dur": step["orig_durs"][cam],
                        "abs_idx": parse_abs_seg_idx(name)
                    }
                    released[cam].append(seg)
                    
                    cam_path = CAM_PATHS[cam]
                    dst = os.path.join(SERVE_DIRS[cam], name)
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    if not os.path.exists(dst):
                        if cam_path.startswith("http://") or cam_path.startswith("https://"):
                            base_url = cam_path.rsplit('/', 1)[0]
                            src_url = f"{base_url}/{name}"
                            with _downloads_lock:
                                is_downloading = dst in _active_downloads
                            if not is_downloading:
                                with _downloads_lock:
                                    _active_downloads.add(dst)
                                threading.Thread(
                                    target=download_segment_file,
                                    args=(src_url, dst, cam, name),
                                    daemon=True
                                ).start()
                        else:
                            src = os.path.join(cam_path, name)
                            if not os.path.exists(src) and USE_BACKUP:
                                backup_src = f"/Users/aryamirani/Desktop/intern/judex/ssh/sync_reports/ts_segments_{cam}/{SESSION_ID}/{name}"
                                if os.path.exists(backup_src):
                                    src = backup_src
                            
                            if os.path.exists(src):
                                try:
                                    os.link(src, dst)
                                except:
                                    temp_dst = dst + ".tmp"
                                    shutil.copy2(src, temp_dst)
                                    os.rename(temp_dst, dst)
                else:
                    # Release missing segment as a gap so the playlist stays synchronized
                    seg = {
                        "name": None,
                        "dur_global": step["dur_global"],
                        "orig_dur": 0.0,
                        "abs_idx": None
                    }
                    released[cam].append(seg)
            
            next_step_idx += 1
                
        # Update server state for status endpoint
        for cam in ["source", "sink", "hq"]:
            idx = next_step_idx - 1
            if idx >= 0 and idx < len(unified_steps):
                step = unified_steps[idx]
                name = step["names"][cam]
                abs_idx = parse_abs_seg_idx(name) if name else None
                server_state[cam]["current_index"] = abs_idx
                is_gap_now = (target_sim_time >= step["t_start"] + step["orig_durs"][cam])
                server_state[cam]["is_gap"] = is_gap_now
            else:
                server_state[cam]["is_gap"] = False
            
        # Write playlists and update sliding window for all cameras
        for cam in ["source", "sink", "hq"]:
            media_items_count = sum(1 for x in released[cam] if isinstance(x, dict))
            while media_items_count > WINDOW_SIZE:
                popped = released[cam].pop(0)
                if isinstance(popped, dict):
                    media_items_count -= 1
                    media_sequence[cam] += 1
                    
                    old_file = os.path.join(SERVE_DIRS[cam], popped["name"])
                    if os.path.exists(old_file):
                        try:
                            os.remove(old_file)
                        except Exception:
                            pass
            
            filtered_released = []
            for item in released[cam]:
                if isinstance(item, dict):
                    name = item["name"]
                    dst = os.path.join(SERVE_DIRS[cam], name)
                    with _downloads_lock:
                        is_downloading = dst in _active_downloads
                    if is_downloading:
                        break
                filtered_released.append(item)
                
            if not filtered_released:
                continue
            
            server_state[cam]["media_sequence"] = media_sequence[cam]
            server_state[cam]["window"] = [x for x in filtered_released if isinstance(x, dict)]
            server_state[cam]["done"] = stream_done
            
            playlist_done = stream_done and (len(filtered_released) == len(released[cam]))
            write_playlist(cam, filtered_released, media_sequence[cam], playlist_done)
            
        # Sleep for a small, responsive interval to poll clock progression
        time.sleep(0.05)

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

from fastapi.responses import PlainTextResponse
import math

@app.get("/stream/{cam}/live.m3u8")
def get_live_m3u8(cam: str):
    if cam not in server_state:
        return PlainTextResponse("Camera not found", status_code=404)
        
    window = server_state[cam].get("window", [])
    media_sequence = server_state[cam].get("media_sequence", 0)
    done = server_state[cam].get("done", False)
    
    target_dur = 6
    for item in window:
        if isinstance(item, dict):
            target_dur = max(target_dur, math.ceil(item.get("dur_global", 0)))
            
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:4",
        f"#EXT-X-TARGETDURATION:{target_dur}",
        f"#EXT-X-MEDIA-SEQUENCE:{media_sequence}",
        "#EXT-X-ALLOW-CACHE:NO",
        "#EXT-X-START:TIME-OFFSET=-4.0"
    ]
    for item in window:
        if isinstance(item, str) and item == "#EXT-X-DISCONTINUITY":
            lines.append(item)
        elif isinstance(item, dict):
            dur = item["dur_global"]
            orig_dur = item.get("orig_durs", {}).get(cam, dur) if "orig_durs" in item else item.get("orig_dur", dur)
            name = item["name"]
            
            if name:
                dst = os.path.join(SERVE_DIRS[cam], name)
                if not os.path.exists(dst):
                    name = None
            
            if name and orig_dur > 0 and (dur - orig_dur) > 0.5:
                # Add original duration and segment
                lines.append(f"#EXTINF:{orig_dur:.6f},")
                lines.append(name)
                # Explicit gap to cover the rest of the time
                lines.append("#EXT-X-DISCONTINUITY")
                lines.append(f"#EXTINF:{(dur - orig_dur):.6f},")
                lines.append("#EXT-X-GAP")
                lines.append("gap.ts")
            elif name is not None:
                lines.append(f"#EXTINF:{dur:.6f},")
                lines.append(name)
            else:
                # Name is None (segment is missing/camera offline)
                lines.append("#EXT-X-DISCONTINUITY")
                lines.append(f"#EXTINF:{dur:.6f},")
                lines.append("#EXT-X-GAP")
                lines.append("gap.ts")
                
    if done:
        lines.append("#EXT-X-ENDLIST")
        
    return PlainTextResponse("\n".join(lines) + "\n")

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
    if from_seg in seg_to_frame[from_camera]:
        start_frame = seg_to_frame[from_camera][from_seg]
    else:
        # Fallback extrapolation
        if seg_to_frame[from_camera]:
            closest_seg = min(seg_to_frame[from_camera].keys(), key=lambda x: abs(x - from_seg))
            start_frame = seg_to_frame[from_camera][closest_seg] + (from_seg - closest_seg) * 180
        else:
            start_frame = from_seg * 180
        
    current_frame = start_frame + int(from_offset * FPS)
    
    # We might ask for a frame slightly outside the range, clamp to closest available
    available_frames = list(frame_to_seg[from_camera].keys())
    if available_frames and current_frame not in frame_to_seg[from_camera]:
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
            if sync_maps[map_key]:
                closest = min(sync_maps[map_key].keys(), key=lambda x: abs(x - current_frame))
                target_frame = sync_maps[map_key][closest]
            else:
                target_frame = current_frame
            
        if target_frame not in frame_to_seg[target_cam]:
            available = list(frame_to_seg[target_cam].keys())
            if available:
                target_frame = min(available, key=lambda x: abs(x - target_frame))
                t_seg, t_frame_offset = frame_to_seg[target_cam][target_frame]
            else:
                t_seg = int(target_frame / 180)
                t_frame_offset = target_frame % 180
        else:
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
        if sn in seg_to_frame[from_camera]:
            start_frame = seg_to_frame[from_camera][sn]
        else:
            if seg_to_frame[from_camera]:
                closest_seg = min(seg_to_frame[from_camera].keys(), key=lambda x: abs(x - sn))
                start_frame = seg_to_frame[from_camera][closest_seg] + (sn - closest_seg) * 180
            else:
                start_frame = sn * 180
        
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
                if sync_maps[map_key]:
                    closest = min(sync_maps[map_key].keys(), key=lambda x: abs(x - start_frame))
                    target_frame = sync_maps[map_key][closest]
                else:
                    target_frame = start_frame
                
            if target_frame not in frame_to_seg[target_cam]:
                available = list(frame_to_seg[target_cam].keys())
                if available:
                    target_frame = min(available, key=lambda x: abs(x - target_frame))
                    t_seg, t_frame_offset = frame_to_seg[target_cam][target_frame]
                else:
                    t_seg = int(target_frame / 180)
                    t_frame_offset = target_frame % 180
            else:
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
            if seg_to_frame[cam]:
                closest_seg = min(seg_to_frame[cam].keys(), key=lambda x: abs(x - seg))
                frames[cam] = seg_to_frame[cam][closest_seg] + (seg - closest_seg) * 180 + int(off * FPS)
            else:
                frames[cam] = seg * 180 + int(off * FPS)

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
                raw_expected = anchor_frame
                exact = False
            # Step 2: clamp raw_expected to nearest valid frame in target's frame index
            # (same correction /sync uses — handles 1:1 maps that go out of range)
            if raw_expected in frame_to_seg[target]:
                expected = raw_expected
            elif frame_to_seg[target]:
                expected = min(frame_to_seg[target].keys(), key=lambda x: abs(x - raw_expected))
            else:
                expected = raw_expected
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

# The obsolete synchronize_streams thread has been removed as timeline alignment is handled contiguously.

if __name__ == "__main__":
    print(f"Starting server on port {_args.port} at {SPEED}x speed (session {SESSION_ID}).")
    uvicorn.run(app, host="0.0.0.0", port=_args.port, log_level="error")
