#!/usr/bin/env python3
#version1 is ready - review mode shifting happens, other than that no other problem.
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
TEST_WORK_DIR = os.path.join(ASSIGNMENT_DIR, "test_work")

WINDOW_SIZE = 35

# Global state for sliding windows
server_state = {
    "source": {"media_sequence": 0, "window": [], "done": False, "current_index": 0, "is_gap": False},
    "sink":   {"media_sequence": 0, "window": [], "done": False, "current_index": 0, "is_gap": False},
    "hq":     {"media_sequence": 0, "window": [], "done": False, "current_index": 0, "is_gap": False},
}

_logged_segments = {
    "source": {"loaded": set(), "removed": set()},
    "sink": {"loaded": set(), "removed": set()},
    "hq": {"loaded": set(), "removed": set()}
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

_events_by_id = {}
_events_lock = threading.Lock()

FPS = 30.0

# Placeholder for the remote flight shots path on the Jetson
REMOTE_FLIGHT_SHOTS_PATH = "/home/jetson/Desktop/cv_output/correlation/flight_shots.csv"

_flight_shots_rows_loaded = 0
  # number of data rows already ingested (excludes header)
_sync_lock = threading.Lock()

_frame_idx_rows = {"source": 0, "sink": 0, "hq": 0}
_frame_idx_lock = threading.Lock()


def _ssh_fetch(remote_path, skip_lines=0, delay_seconds=0):
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
        return "".join(lines[skip_lines + 1:])


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

def _safe_frame_int(val):
    """Parse a frame index; return None if missing or non-numeric."""
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    if isinstance(val, str):
        val = val.strip()
        if not val or "," in val:
            return None
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None


def _resolve_bounce_hq_frame_unlocked(bounce_frame, bounce_hq_frame):
    hq = _safe_frame_int(bounce_hq_frame)
    if hq is not None:
        return hq
    bf = _safe_frame_int(bounce_frame)
    if bf is None:
        return None
    mapped = sync_maps["source_to_hq"].get(bf)
    if mapped is not None:
        return mapped
    if sync_maps["source_to_hq"]:
        closest = min(sync_maps["source_to_hq"].keys(), key=lambda x: abs(x - bf))
        return sync_maps["source_to_hq"][closest] + (bf - closest)
    return bf


def _position_from_hq_frame(f_hq):
    """Map an HQ frame number to per-camera segment+offset using sync/frame indexes."""
    f_hq = _safe_frame_int(f_hq)
    if f_hq is None:
        return None, None, None

    src_frame = sync_maps["hq_to_source"].get(f_hq)
    if src_frame is None:
        if sync_maps["hq_to_source"]:
            closest = min(sync_maps["hq_to_source"].keys(), key=lambda x: abs(x - f_hq))
            src_frame = sync_maps["hq_to_source"][closest] + (f_hq - closest)
        else:
            src_frame = f_hq

    sink_frame = sync_maps["hq_to_sink"].get(f_hq)
    if sink_frame is None:
        if sync_maps["hq_to_sink"]:
            closest = min(sync_maps["hq_to_sink"].keys(), key=lambda x: abs(x - f_hq))
            sink_frame = sync_maps["hq_to_sink"][closest] + (f_hq - closest)
        else:
            sink_frame = f_hq

    segs = {}
    offs = {}
    frames = {}
    for cam, f_num in [("source", src_frame), ("sink", sink_frame), ("hq", f_hq)]:
        frames[cam] = int(f_num)
        if f_num in frame_to_seg[cam]:
            c_seg, c_off = frame_to_seg[cam][f_num]
            segs[cam] = c_seg
            offs[cam] = c_off / FPS
        else:
            if seg_to_frame[cam]:
                closest_seg = min(seg_to_frame[cam].keys(), key=lambda s: abs(seg_to_frame[cam][s] - f_num))
                closest_start = seg_to_frame[cam][closest_seg]
                fc = seg_frame_count[cam].get(closest_seg, 120)
                frame_delta = f_num - closest_start
                segs[cam] = closest_seg + frame_delta // fc
                offs[cam] = (frame_delta % fc) / FPS
            else:
                avg_fc = 120 if not seg_frame_count[cam] else list(seg_frame_count[cam].values())[-1]
                segs[cam] = int(f_num / avg_fc)
                offs[cam] = (f_num % avg_fc) / FPS
    return segs, offs, frames


def _refresh_event_positions(event):
    """Recompute segment positions — frame index may have grown since first ingest."""
    meta = event.get("metadata") or {}
    bounce_frame = event.get("bounce_frame") or _safe_frame_int(meta.get("bounce_frame"))
    hq_frame = _resolve_bounce_hq_frame_unlocked(bounce_frame, meta.get("bounce_hq_frame"))
    if hq_frame is None:
        hq_frame = _safe_frame_int(event.get("hq_frame")) or _safe_frame_int(meta.get("bounce_hq_frame"))
    if hq_frame is None:
        return event

    segs, offs, frames = _position_from_hq_frame(hq_frame)
    if segs is None:
        return event

    refreshed = dict(event)
    refreshed["segments"] = segs
    refreshed["offsets"] = offs
    refreshed["frames"] = frames
    refreshed["hq_frame"] = hq_frame

    start_segs, start_offs, _ = _position_from_hq_frame(meta.get("start_frame"))
    end_segs, end_offs, _ = _position_from_hq_frame(meta.get("end_frame"))
    if start_segs is not None:
        refreshed["start_segments"] = start_segs
        refreshed["start_offsets"] = start_offs
    if end_segs is not None:
        refreshed["end_segments"] = end_segs
        refreshed["end_offsets"] = end_offs
    return refreshed


def _ingest_flight_shots(csv_text, has_header=True):
    if not csv_text.strip():
        return 0
    df = pd.read_csv(io.StringIO(csv_text)) if has_header else pd.read_csv(io.StringIO(csv_text), header=None)
    # If header=None, we'd need to assign column names, but for simplicity we assume the header is fetched once 
    # or we always fetch with headers if using pandas or just parse manually.
    # Actually, pd.read_csv is tricky with skip_lines. Let's just use the same manual parsing or ensure it handles it.
    # If has_header is False, we need to supply names. Let's assume the CSV always has the same columns.
    # To keep it simple, let's just parse the whole file every time or just read the new lines.
    # If reading new lines, we must supply the names:
    col_names = ["flight_id","start_frame","end_frame","origin_track_ids","primary_origin_track_id",
                 "crossed_sides","crossed_sides_confidence","likely_net_hit","ended_near_net",
                 "counts_as_shot","counts_in_shot_stats","shot_id","dedupe_reason","reason_codes",
                 "net_crossing_frame","landing_x","landing_y","landing_confidence","bounce_frame",
                 "bounce_x","bounce_y","bounce_z","bounce_score","bounce_mode","bbox_source_x",
                 "bbox_source_y","bbox_source_w","bbox_source_h","bbox_sink_x","bbox_sink_y",
                 "bbox_sink_w","bbox_sink_h","bounce_hq_frame","window_frames"]
    
    if not has_header:
        df = pd.read_csv(io.StringIO(csv_text), header=None, names=col_names)

    count = 0
    for _, row in df.iterrows():
        bounce_frame = _safe_frame_int(row.get('bounce_frame'))
        if bounce_frame is None and pd.isna(row.get('bounce_hq_frame')):
            continue

        with _sync_lock, _frame_idx_lock:
            hq_frame = _resolve_bounce_hq_frame_unlocked(bounce_frame, row.get('bounce_hq_frame'))
            if hq_frame is None:
                continue

            segs, offs, frames = _position_from_hq_frame(hq_frame)
            if segs is None:
                continue
            start_segs, start_offs, _ = _position_from_hq_frame(row.get('start_frame'))
            end_segs, end_offs, _ = _position_from_hq_frame(row.get('end_frame'))

        metadata = {}
        for k, v in row.items():
            if pd.isna(v):
                metadata[k] = None
            else:
                metadata[k] = v

        event = {
            "id": str(row['shot_id']),
            "segments": segs,
            "offsets": offs,
            "frames": frames,
            "start_segments": start_segs,
            "start_offsets": start_offs,
            "end_segments": end_segs,
            "end_offsets": end_offs,
            "hq_frame": hq_frame,
            "bounce_frame": bounce_frame,
            "metadata": metadata
        }
        with _events_lock:
            is_new = event["id"] not in _events_by_id
            _events_by_id[event["id"]] = event
        if is_new:
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

def flight_shots_poller():
    """Background thread: polls flight shots CSV every 2 s for new events."""
    global _flight_shots_rows_loaded
    while True:
        time.sleep(2)
        try:
            text = _ssh_fetch(REMOTE_FLIGHT_SHOTS_PATH, skip_lines=_flight_shots_rows_loaded)
            added = _ingest_flight_shots(text, has_header=(_flight_shots_rows_loaded == 0))
            if added:
                _flight_shots_rows_loaded += added
                print(f"[flight shots poller] +{added} events (total {_flight_shots_rows_loaded})")
        except Exception as e:
            # print(f"[flight shots poller] error: {e}")
            pass

def load_data():
    global _events_by_id, _sync_rows_loaded
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
    global _flight_shots_rows_loaded
    print(f"  Fetching remote flight shots CSV: {REMOTE_FLIGHT_SHOTS_PATH}")
    try:
        csv_text = _ssh_fetch(REMOTE_FLIGHT_SHOTS_PATH, skip_lines=0)
        _flight_shots_rows_loaded = _ingest_flight_shots(csv_text, has_header=True)
        print(f"  Loaded {_flight_shots_rows_loaded} events from remote.")
    except Exception as e:
        print(f"  Could not load remote flight shots (will poll later). Error: {e}")
        
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
            if name:
                cam_path = CAM_PATHS[cam]
                if cam_path.startswith("http://") or cam_path.startswith("https://"):
                    base_url = cam_path.rsplit('/', 1)[0]
                    name = f"{base_url}/{name}"
            
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
            return abs_idx * 120
        closest_seg = min(keys, key=lambda x: abs(x - abs_idx))
        fc = seg_frame_count[cam].get(closest_seg, 120)
        return seg_to_frame[cam][closest_seg] + (abs_idx - closest_seg) * fc

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
    finally:
        with _downloads_lock:
            _active_downloads.discard(dst)

@asynccontextmanager
async def lifespan(app: FastAPI):
    load_data()
    threading.Thread(target=sync_csv_poller, daemon=True).start()
    threading.Thread(target=frame_idx_poller, daemon=True).start()
    threading.Thread(target=flight_shots_poller, daemon=True).start()
    yield

app = FastAPI(lifespan=lifespan)
app.mount("/clips_serve", StaticFiles(directory="clips/sync_reports"), name="clips_serve")
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
    from fastapi.responses import PlainTextResponse
    import os
    import time
    
    playlist_path = f"clips/sync_reports/ts_segments_{cam}/{SESSION_ID}/playlist.m3u8"
    if not os.path.exists(playlist_path):
        print(f"[STRICT ENFORCEMENT] React tried to fetch live.m3u8 for {cam} before simulation started. DENIED (404)!")
        return PlainTextResponse("Playlist not found", status_code=404)
        
    sim_time = ((time.time() - START_TIME) * SPEED) + PRE_BUFFER
    
    with open(playlist_path, "r") as f:
        lines = f.read().splitlines()
        
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
        
    # Only expose segments up to sim_time based on cumulative duration
    exposed_segments = []
    cumulative = 0.0
    for inf, seg, dur in segments:
        if cumulative <= sim_time:
            exposed_segments.append((inf, seg))
        else:
            break
        cumulative += dur
        
    if not exposed_segments and segments:
        exposed_segments = [(segments[0][0], segments[0][1])]
    
    # 30 segment sliding window
    window_segments = exposed_segments[-WINDOW_SIZE:]
    window_seg_names = {seg for inf, seg in window_segments}
    
    for inf, seg in exposed_segments:
        if seg in window_seg_names:
            if seg not in _logged_segments[cam]["loaded"]:
                print(f"[EVICTION LOGIC] Segment {seg} of {cam} loaded in server m3u8 playlist")
                _logged_segments[cam]["loaded"].add(seg)
        else:
            if seg not in _logged_segments[cam]["removed"]:
                print(f"[EVICTION LOGIC] Segment {seg} of {cam} removed from server m3u8 playlist (max {WINDOW_SIZE} segments)")
                _logged_segments[cam]["removed"].add(seg)
    
    # Rebuild m3u8
    out_lines = header_lines[:]
    
    # Update sequence number
    seq_idx = -1
    for idx, line in enumerate(out_lines):
        if line.startswith("#EXT-X-MEDIA-SEQUENCE"):
            seq_idx = idx
            break
            
    seq_num = max(0, len(exposed_segments) - WINDOW_SIZE)
    if seq_idx != -1:
        out_lines[seq_idx] = f"#EXT-X-MEDIA-SEQUENCE:{seq_num}"
    else:
        out_lines.append(f"#EXT-X-MEDIA-SEQUENCE:{seq_num}")
        
    for inf, seg in window_segments:
        out_lines.append(inf)
        out_lines.append(seg)
    return PlainTextResponse("\n".join(out_lines), media_type="application/vnd.apple.mpegurl")


from fastapi.responses import FileResponse

@app.get("/stream/{cam}/{segment}.ts")
def serve_segment(cam: str, segment: str):
    dst = os.path.join("clips/sync_reports", f"ts_segments_{cam}", str(SESSION_ID), f"{segment}.ts")
    if not os.path.exists(dst):
        print(f"[STRICT ENFORCEMENT] React tried to fetch {cam}/{segment}.ts before Wi-Fi fetch completed. DENIED (404)!")
        return PlainTextResponse("File not yet downloaded from Pi", status_code=404)
    return FileResponse(dst)

# For the bounce clips
BOUNCE_CLIPS_DIR = os.path.join(BASE_DIR, "clips", "cv_output", "bounce_clips")
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
            start_frame = seg_to_frame[from_camera][closest_seg] + (from_seg - closest_seg) * 120
        else:
            start_frame = from_seg * 120
        
    current_frame = start_frame + int(from_offset * FPS)
    
    # We might ask for a frame slightly outside the range, clamp to closest available
    available_frames = list(frame_to_seg[from_camera].keys())
    if available_frames and current_frame not in frame_to_seg[from_camera]:
        current_frame = min(available_frames, key=lambda x: abs(x - current_frame))

    # Get corresponding frames
    res = {}
    for target_cam in ["source", "sink", "hq"]:
        if target_cam == from_camera:
            res[target_cam] = {"segment": from_seg, "offset": from_offset, "frame": current_frame, "searched_frame": current_frame}
            continue
            
        map_key = f"{from_camera}_to_{target_cam}"
        if current_frame in sync_maps[map_key]:
            target_frame = sync_maps[map_key][current_frame]
        else:
            # Fallback if frame dropped/missing from sync map: just pick the closest and extrapolate
            if sync_maps[map_key]:
                closest = min(sync_maps[map_key].keys(), key=lambda x: abs(x - current_frame))
                target_frame = sync_maps[map_key][closest] + (current_frame - closest)
            else:
                target_frame = current_frame
            
        if target_frame not in frame_to_seg[target_cam]:
            if seg_to_frame[target_cam]:
                closest_seg = min(seg_to_frame[target_cam].keys(), key=lambda s: abs(seg_to_frame[target_cam][s] - target_frame))
                closest_start = seg_to_frame[target_cam][closest_seg]
                frame_delta = target_frame - closest_start
                fc = seg_frame_count[target_cam].get(closest_seg, 120)
                seg_delta = frame_delta // fc
                t_seg = closest_seg + seg_delta
                t_frame_offset = frame_delta % fc
            else:
                avg_fc = 120 if not seg_frame_count[target_cam] else list(seg_frame_count[target_cam].values())[-1]
                t_seg = int(target_frame / avg_fc)
                t_frame_offset = target_frame % avg_fc
        else:
            t_seg, t_frame_offset = frame_to_seg[target_cam][target_frame]
            
        res[target_cam] = {
            "segment": t_seg,
            "offset": t_frame_offset / FPS,
            "frame": target_frame,
            "searched_frame": current_frame
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
    with _sync_lock, _frame_idx_lock:
        for sn in sn_list:
            if sn in seg_to_frame[from_camera]:
                start_frame = seg_to_frame[from_camera][sn]
            else:
                if seg_to_frame[from_camera]:
                    closest_seg = min(seg_to_frame[from_camera].keys(), key=lambda x: abs(x - sn))
                    fc = seg_frame_count[from_camera].get(closest_seg, 120)
                    start_frame = seg_to_frame[from_camera][closest_seg] + (sn - closest_seg) * fc
                else:
                    start_frame = sn * 120
            
            # Get corresponding frames at the start of this segment
            seg_res = {}
            for target_cam in ["source", "sink", "hq"]:
                if target_cam == from_camera:
                    seg_res[target_cam] = {"segment": sn, "offset": 0.0, "frame": start_frame, "searched_frame": start_frame}
                    continue
                    
                map_key = f"{from_camera}_to_{target_cam}"
                if start_frame in sync_maps[map_key]:
                    target_frame = sync_maps[map_key][start_frame]
                else:
                    if sync_maps[map_key]:
                        closest = min(sync_maps[map_key].keys(), key=lambda x: abs(x - start_frame))
                        target_frame = sync_maps[map_key][closest] + (start_frame - closest)
                    else:
                        target_frame = start_frame
                    
                if target_frame not in frame_to_seg[target_cam]:
                    if seg_to_frame[target_cam]:
                        closest_seg = min(seg_to_frame[target_cam].keys(), key=lambda s: abs(seg_to_frame[target_cam][s] - target_frame))
                        closest_start = seg_to_frame[target_cam][closest_seg]
                        frame_delta = target_frame - closest_start
                        fc = seg_frame_count[target_cam].get(closest_seg, 120)
                        seg_delta = frame_delta // fc
                        t_seg = closest_seg + seg_delta
                        t_frame_offset = frame_delta % fc
                    else:
                        avg_fc = 120 if not seg_frame_count[target_cam] else list(seg_frame_count[target_cam].values())[-1]
                        t_seg = int(target_frame / avg_fc)
                        t_frame_offset = target_frame % avg_fc
                else:
                    t_seg, t_frame_offset = frame_to_seg[target_cam][target_frame]
                    
                seg_res[target_cam] = {
                    "segment": t_seg,
                    "offset": t_frame_offset / FPS,
                    "frame": target_frame,
                    "searched_frame": start_frame
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
    with _sync_lock, _frame_idx_lock:
        for cam, (seg, off) in positions.items():
            if seg in seg_to_frame[cam]:
                frames[cam] = seg_to_frame[cam][seg] + int(off * FPS)
            else:
                if seg_to_frame[cam]:
                    closest_seg = min(seg_to_frame[cam].keys(), key=lambda x: abs(x - seg))
                    fc = seg_frame_count[cam].get(closest_seg, 120)
                    frames[cam] = seg_to_frame[cam][closest_seg] + (seg - closest_seg) * fc + int(off * FPS)
                else:
                    frames[cam] = seg * 120 + int(off * FPS)
    
        # For each (anchor, target) pair, check CSV prediction vs actual target frame
        pairs = [("source", "sink"), ("source", "hq"), ("sink", "hq")]
        checks = {}
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
    with _events_lock, _sync_lock, _frame_idx_lock:
        refreshed = [_refresh_event_positions(ev) for ev in _events_by_id.values()]
        # One event per bounce_frame — CSV can contain duplicate shot rows for the same clip
        by_bounce = {}
        for ev in refreshed:
            bf = ev.get("bounce_frame") or _safe_frame_int((ev.get("metadata") or {}).get("bounce_frame"))
            if bf is None:
                by_bounce[f"id:{ev['id']}"] = ev
                continue
            key = f"bf:{bf}"
            prev = by_bounce.get(key)
            if prev is None or (ev.get("hq_frame") or 0) >= (prev.get("hq_frame") or 0):
                by_bounce[key] = ev
        return list(by_bounce.values())

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
