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
import json
import pandas as pd
import re
from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
import pydantic
from typing import List
from contextlib import asynccontextmanager

# Parse args at module level so SESSION_ID is available before lifespan runs
_parser = argparse.ArgumentParser()
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
_parser.add_argument(
    "--offline", "--sim", action="store_true", default=False,
    help="Run in offline simulation mode using local datasets without SSH",
)
_parser.add_argument(
    "--start-segment", type=int, default=0,
    help="Starting segment index for offline simulation mode",
)
_parser.add_argument(
    "--start-frame", type=int, default=None,
    help="Starting frame index for offline simulation mode",
)
_args = _parser.parse_args()

SPEED = _args.speed
CAM_PORT = _args.cam_port
JETSON_CV_DIR = "/home/jetson/Desktop/judex-cv"

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
        "-o", "ConnectTimeout=5",
        "-o", "StrictHostKeyChecking=accept-new",
        host,
        remote_cmd,
    ]

def _fetch_session_from_source_pi():
    import sys
    try:
        result = subprocess.run(
            _ssh_argv(SOURCE_PI_HOST, f"cat {TRACK_VIDEO_INDEX_PATH}"),
            capture_output=True, text=True, timeout=5,
        )
        result.check_returncode()
        data = json.loads(result.stdout.strip())
        return str(data["counter"])
    except subprocess.TimeoutExpired:
        print(f"\n[FATAL] Network Error: Connection to {SOURCE_PI_HOST} timed out.")
        print("Please ensure you are connected to the correct WiFi network and the Pi is online.")
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        print(f"\n[FATAL] Error reading {TRACK_VIDEO_INDEX_PATH} from {SOURCE_PI_HOST}.")
        print(f"SSH Output: {e.stderr.strip() if e.stderr else 'Unknown Error'}\n")
        sys.exit(1)
    except Exception as e:
        print(f"\n[FATAL] Unexpected error resolving session ID: {e}\n")
        sys.exit(1)

def resolve_session_id():
    if _args.session:
        return str(_args.session)
    if _args.offline:
        return "1870"
    return _fetch_session_from_source_pi()

SESSION_ID = resolve_session_id()

REMOTE_CSV_PATH = f"/home/jetson/Desktop/apr17/sync_reports/segments_{SESSION_ID}/sync/hls_sync_{SESSION_ID}_triple.csv"
FRAME_IDX_PATHS = {
    cam: f"/home/jetson/Desktop/apr17/sync_reports/segments_{SESSION_ID}/manifests/{cam}/hls_segment_frame_index.csv"
    for cam in ["source", "sink", "hq"]
}
DATA_DIR = os.path.join(ASSIGNMENT_DIR, "sync_reports")
if not os.path.exists(DATA_DIR):
    DATA_DIR = os.path.join(ASSIGNMENT_DIR, "apr17", "sync_reports")

CV_OUTPUT_DIR = os.path.join(ASSIGNMENT_DIR, "cv_output_july21")
if not os.path.exists(CV_OUTPUT_DIR):
    CV_OUTPUT_DIR = os.path.join(ASSIGNMENT_DIR, "cv_output")

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

_missing_hq_frames = set()

# frame -> (seg_index, frame_offset)
frame_to_seg = { "source": {}, "sink": {}, "hq": {} }
seg_to_frame = { "source": {}, "sink": {}, "hq": {} } # seg_index -> cumulative_start_frame
seg_frame_count = { "source": {}, "sink": {}, "hq": {} } # seg_index -> frame_count

# Paths
CAM_PATHS = {
    "source": f"http://192.168.0.111:{CAM_PORT}/live.m3u8",
    "hq":     f"http://192.168.0.112:{CAM_PORT}/live.m3u8",
    "sink":   f"http://192.168.0.113:{CAM_PORT}/live.m3u8"
}

SERVE_DIRS = {
    "source": os.path.join(BASE_DIR, "serve", "source"),
    "sink": os.path.join(BASE_DIR, "serve", "sink"),
    "hq": os.path.join(BASE_DIR, "serve", "hq")
}

_events_by_id = {}
_events_lock = threading.Lock()

_admitted_segments = {"source": [], "sink": [], "hq": []}
_evicted_count = {"source": 0, "sink": 0, "hq": 0}

FPS = 30.0

# Placeholder for the remote flight shots path on the Jetson
REMOTE_FLIGHT_SHOTS_PATH = "/home/jetson/Desktop/cv_output/correlation/flight_shots.csv"

_flight_shots_rows_loaded = 0
_flight_shots_header = ""
  # number of data rows already ingested (excludes header)
# Running count of every flight_shots.csv data row we have seen, in CSV order
# (including rows we skip). Used to assign each event its absolute 0-based csv_row,
# which is the identifier run_graphics.sh expects.
_flight_shots_data_rows_seen = 0
_sync_lock = threading.Lock()

_frame_idx_rows = {"source": 0, "sink": 0, "hq": 0}
_frame_idx_lock = threading.Lock()


def _resolve_local_path(remote_path):
    if "hls_sync_" in remote_path:
        return os.path.join(DATA_DIR, f"segments_{SESSION_ID}", "sync", f"hls_sync_{SESSION_ID}_triple.csv")
    elif "hls_segment_frame_index.csv" in remote_path:
        for cam in ["source", "sink", "hq"]:
            if f"manifests/{cam}/" in remote_path or f"/{cam}/" in remote_path:
                return os.path.join(DATA_DIR, f"segments_{SESSION_ID}", "manifests", cam, "hls_segment_frame_index.csv")
    elif "flight_shots" in remote_path:
        return os.path.join(CV_OUTPUT_DIR, "correlation", "flight_shots.csv")
    return None

def _ssh_fetch(remote_path, skip_lines=0, allow_empty=True):
    if _args.offline:
        local_p = _resolve_local_path(remote_path)
        if local_p and os.path.exists(local_p):
            try:
                with open(local_p, "r", encoding="utf-8", errors="replace") as f:
                    lines = f.readlines()
                if skip_lines > 0:
                    lines = lines[skip_lines:]
                return "".join(lines)
            except Exception as e:
                print(f"[local fetch] Error reading {local_p}: {e}")
                if allow_empty:
                    return ""
                raise e
        return ""

    try:
        remote_cmd = (f"cat {remote_path}" if skip_lines == 0
                      else f"tail -n +{skip_lines + 1} {remote_path} 2>/dev/null || true")
        result = subprocess.run(
            _ssh_argv(JETSON_HOST, remote_cmd),
            capture_output=True, text=True, timeout=60
        )
        if result.returncode != 0 and not allow_empty:
            result.check_returncode()
        return result.stdout
    except Exception as e:
        if allow_empty:
            return ""
        raise e

def _ssh_fetch_with_cmd(remote_cmd, allow_empty=True):
    try:
        result = subprocess.run(
            _ssh_argv(JETSON_HOST, remote_cmd),
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0 and not allow_empty:
            result.check_returncode()
        return result.stdout
    except Exception as e:
        if allow_empty:
            return ""
        raise e

def _fetch_flight_shots_csv(skip_lines=0):
    return _ssh_fetch(REMOTE_FLIGHT_SHOTS_PATH, skip_lines, allow_empty=True)


def _fetch_csv_lines(skip_lines=0):
    return _ssh_fetch(REMOTE_CSV_PATH, skip_lines)

def _ingest_sync_rows(csv_text, has_header=True):
    """Parse csv_text and update sync_maps. Returns number of rows ingested."""
    if not csv_text.strip():
        return 0
        
    if has_header:
        df = pd.read_csv(io.StringIO(csv_text))
    else:
        df = pd.read_csv(io.StringIO(csv_text), header=None)
        
    count = 0
    with _sync_lock:
        for _, row in df.iterrows():
            src_col = row.get('Source_Index') if has_header else row.get(0)
            snk_col = row.get('Sink_Index') if has_header else row.get(1)
            hq_col = row.get('HQ_Index') if has_header else row.get(2)
            status_col = row.get('TripleStatus') if has_header else row.get(7)
            
            if pd.isna(src_col) or pd.isna(snk_col):
                continue
                
            src_idx = int(src_col)
            snk_idx = int(snk_col)
            
            sync_maps["source_to_sink"][src_idx] = snk_idx
            sync_maps["sink_to_source"][snk_idx] = src_idx
            
            if pd.isna(hq_col) or status_col == "MISSING_HQ":
                _missing_hq_frames.add(src_idx)
                _missing_hq_frames.add(snk_idx)
                continue
                
            hq_idx  = int(hq_col)
            sync_maps["source_to_hq"][src_idx] = hq_idx
            sync_maps["sink_to_hq"][snk_idx] = hq_idx
            sync_maps["hq_to_source"][hq_idx] = src_idx
            sync_maps["hq_to_sink"][hq_idx] = snk_idx
            count += 1
    return count

def sync_csv_poller():
    """
    Background thread: polls the remote sync CSV every 4 seconds and ingests new rows.
    """
    global _sync_rows_loaded
    while True:
        time.sleep(4)
        try:
            new_text = _ssh_fetch(REMOTE_CSV_PATH, skip_lines=_sync_rows_loaded, allow_empty=True)
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
    return sync_maps["source_to_hq"].get(bf)


def _position_from_hq_frame(f_hq):
    """Map an HQ frame number to per-camera segment+offset using sync/frame indexes."""
    f_hq = _safe_frame_int(f_hq)
    if f_hq is None:
        return None, None, None

    src_frame = sync_maps["hq_to_source"].get(f_hq)
    sink_frame = sync_maps["hq_to_sink"].get(f_hq)

    if src_frame is None or sink_frame is None:
        return None, None, None

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
            return None, None, None
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


def _ingest_flight_shots(csv_text):
    global _flight_shots_data_rows_seen
    if not csv_text.strip():
        return 0
    df = pd.read_csv(io.StringIO(csv_text))

    count = 0
    for _, row in df.iterrows():
        # Absolute 0-based data-row index in flight_shots.csv, matching the Jetson's
        # csv.DictReader enumeration (counts every data row, including skipped ones).
        # This is the csv_row identifier that run_graphics.sh expects.
        csv_row = _flight_shots_data_rows_seen
        _flight_shots_data_rows_seen += 1

        # New CSV column: skip bounces explicitly flagged invalid (valid_bounce == 0).
        # Guarded so a missing/NaN value never drops a row.
        valid_bounce = _safe_frame_int(row.get('valid_bounce'))
        if valid_bounce == 0:
            continue

        bounce_frame = _safe_frame_int(row.get('bounce_frame'))
        if bounce_frame is None and pd.isna(row.get('bounce_hq_frame')):
            continue

        # IMPORTANT: store the event even if its segment positions can't be computed yet.
        # A bounce can appear in flight_shots.csv before the sync / frame-index maps have
        # caught up to that frame. If we dropped it here, the CSV cursor would advance past
        # the row and it would never be re-read — so its timeline dot would never appear,
        # even once the maps catch up. Instead we persist it with segments=None and let
        # _refresh_event_positions() (called on every /events poll) fill them in later.
        with _sync_lock, _frame_idx_lock:
            hq_frame = _resolve_bounce_hq_frame_unlocked(bounce_frame, row.get('bounce_hq_frame'))
            if hq_frame is not None:
                segs, offs, frames = _position_from_hq_frame(hq_frame)
            else:
                segs, offs, frames = None, None, None
            if segs is not None:
                start_segs, start_offs, _ = _position_from_hq_frame(row.get('start_frame'))
                end_segs, end_offs, _ = _position_from_hq_frame(row.get('end_frame'))
            else:
                start_segs = start_offs = end_segs = end_offs = None

        metadata = {}
        for k, v in row.items():
            if pd.isna(v):
                metadata[k] = None
            else:
                metadata[k] = v
        metadata["csv_row"] = csv_row

        event = {
            "id": str(row['shot_id']),
            "csv_row": csv_row,
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
            _events_by_id[event["id"]] = event
            count += 1

    return count

def frame_idx_poller():
    """Background thread: polls each camera's frame index CSV every 2 s for new segments."""
    global _frame_idx_rows
    while True:
        time.sleep(2)
        for cam in ["source", "sink", "hq"]:
            try:
                text = _ssh_fetch(FRAME_IDX_PATHS[cam], skip_lines=_frame_idx_rows[cam], allow_empty=True)
                added = _ingest_frame_idx_rows(cam, text, has_header=(_frame_idx_rows[cam] == 0))
                if added:
                    _frame_idx_rows[cam] += added
                    print(f"[frame idx poller] {cam} +{added} segs (total {_frame_idx_rows[cam]})")
            except Exception as e:
                print(f"[frame idx poller] {cam} error: {e}")

def _refresh_flight_shots():
    """Fetch any new flight shots rows from the Jetson on-demand.

    Called when the frontend requests /events (i.e. on entering review mode), so we
    avoid a continuous background poller hammering the Jetson during live playback —
    the bounce/event data is only needed in review mode.
    """
    global _flight_shots_rows_loaded, _flight_shots_header
    try:
        text = _fetch_flight_shots_csv(skip_lines=_flight_shots_rows_loaded)
        if not text.strip():
            return

        if _flight_shots_rows_loaded == 0:
            _flight_shots_header = text.splitlines()[0]
            _ingest_flight_shots(text)
        else:
            full_text = _flight_shots_header + "\n" + text
            _ingest_flight_shots(full_text)

        added_lines = len(text.strip().splitlines())
        _flight_shots_rows_loaded += added_lines
        print(f"[flight shots] +{added_lines} events (total {_flight_shots_rows_loaded})")
    except Exception:
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
                
    # 3. Events (flight shots) are loaded lazily on the first /events request
    #    (i.e. when the user enters review mode) — no need to fetch them at startup.
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

# def get_global_time(cam, frame):
#     if cam == "source":
#         return frame / FPS
#     map_key = f"{cam}_to_source"
#     
#     with _sync_lock:
#         if not sync_maps[map_key]:
#             return frame / FPS
#             
#         if frame in sync_maps[map_key]:
#             return sync_maps[map_key][frame] / FPS
#             
#         keys = sorted(sync_maps[map_key].keys())
#         import bisect
#         idx = bisect.bisect_left(keys, frame)
#         if idx == 0:
#             ref_f = keys[0]
#             diff = frame - ref_f
#             return (sync_maps[map_key][ref_f] + diff) / FPS
#         elif idx == len(keys):
#             ref_f = keys[-1]
#             diff = frame - ref_f
#             return (sync_maps[map_key][ref_f] + diff) / FPS
#         else:
#             f1 = keys[idx-1]
#             f2 = keys[idx]
#             s1 = sync_maps[map_key][f1]
#             s2 = sync_maps[map_key][f2]
#             ratio = (frame - f1) / (f2 - f1)
#             mapped_frame = s1 + ratio * (s2 - s1)
#             return mapped_frame / FPS

# def get_segment_start_frame(cam, abs_idx):
#     with _frame_idx_lock:
#         if abs_idx in seg_to_frame[cam]:
#             return seg_to_frame[cam][abs_idx]
#         keys = sorted(seg_to_frame[cam].keys())
#         if not keys:
#             return abs_idx * 120
#         closest_seg = min(keys, key=lambda x: abs(x - abs_idx))
#         fc = seg_frame_count[cam].get(closest_seg, 120)
#         return seg_to_frame[cam][closest_seg] + (abs_idx - closest_seg) * fc

def parse_abs_seg_idx(name):
    if not name:
        return None
    import re
    base = os.path.basename(name)
    m = re.search(r'(\d+)\.ts$', base)
    if m:
        return int(m.group(1))
    return None

# def download_segment_file(src_url, dst, cam, name):
#     try:
#         if os.path.exists(dst):
#             return
#         req = urllib.request.Request(src_url, headers={'User-Agent': 'Mozilla/5.0'})
#         with urllib.request.urlopen(req, timeout=3) as response:
#             temp_dst = dst + ".tmp"
#             with open(temp_dst, "wb") as f_dst:
#                 f_dst.write(response.read())
#             os.rename(temp_dst, dst)
#         print(f"[master worker] Downloaded segment {name} from {src_url}")
#     except Exception as e:
#         print(f"[master worker] Error downloading {src_url}: {e}")
#     finally:
#         with _downloads_lock:
#             _active_downloads.discard(dst)

# ═══════════════════════════════════════════════════════════════════════════════
#  DEAD CODE: master_stream_worker()
#  ─────────────────────────────────
#  This function is NOT started by the lifespan() event handler and is never
#  called.  It was part of the simulation-based architecture where the server
#  built a "unified timeline" and wrote local m3u8 playlists.  In the current
#  LIVE architecture, playlists are proxied directly from the Pi cameras via
#  the get_live_m3u8() endpoint.
#
#  Kept here for reference only — the function body is unreachable.
# ═══════════════════════════════════════════════════════════════════════════════
def master_stream_worker():
    return  # ← DEAD CODE: function body is never reached

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
        else:
            playlist_path = os.path.join(cam_path, "playlist.m3u8")
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
    target_sim_time = max(0.0, total_duration - 6.0) if IS_LIVE else 0.0
    
    if IS_LIVE and unified_steps:
        # Fast-forward to only fetch the last 3 segments on startup to avoid massive backlog fetching
        next_step_idx = max(0, len(unified_steps) - 3)
    stream_done = False
    last_playlist_poll = 0.0
    
    while True:
        now = time.time()
        dt = (now - last_time) * SPEED
        last_time = now
        
        # 1. Periodically check playlists
        if now - last_playlist_poll >= 2.0:
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
                        pass

                else:
                    playlist_path = os.path.join(cam_path, "playlist.m3u8")
                    

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
                target_sim_time = max(0.0, total_duration - 6.0)
            
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
                            pass # Real world: React fetches directly from Pi, no middleman download
                        else:
                            src = os.path.join(cam_path, name)
                            if os.path.exists(src):
                                def simulate_download(source, dest, camera, segment_name):
                                    import random
                                    latency = random.uniform(3.0, 6.5)
                                    time.sleep(latency)
                                    try:
                                        os.link(source, dest)
                                    except:
                                        temp_dst = dest + ".tmp"
                                        shutil.copy2(source, temp_dst)
                                        os.rename(temp_dst, dest)
                                    print(f"[SIMULATOR] {camera}/{segment_name} simulated Wi-Fi fetch complete in {latency:.2f}s")
                                    with _downloads_lock:
                                        _active_downloads.discard(dest)

                                with _downloads_lock:
                                    is_downloading = dst in _active_downloads
                                if not is_downloading:
                                    with _downloads_lock:
                                        _active_downloads.add(dst)
                                    threading.Thread(
                                        target=simulate_download,
                                        args=(src, dst, cam, name),
                                        daemon=True
                                    ).start()
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
                    
                    if popped["name"]:
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
                    if name:
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

def _run_tracknet_status():
    """SSH to Jetson and run tracknet_control.py status. Returns stdout string."""
    if _args.offline:
        return "source_sink_tracknet_forceful: off (offline mode)"
    try:
        result = subprocess.run(
            _ssh_argv(JETSON_HOST, "cd /home/jetson/Desktop/judex-cv && python3 tracknet_control.py status"),
            capture_output=True, text=True, timeout=10
        )
        return result.stdout.strip() or result.stderr.strip()
    except Exception as e:
        return f"ERROR: {e}"


def _parse_tracknet_forceful(raw: str) -> str:
    """Extract source_sink_tracknet_forceful value from tracknet_control.py status output."""
    for line in raw.splitlines():
        if "source_sink_tracknet_forceful:" in line:
            return line.split(":", 1)[1].strip()
    return "unknown"


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_data()
    threading.Thread(target=sync_csv_poller, daemon=True).start()
    threading.Thread(target=frame_idx_poller, daemon=True).start()
    print("[tracknet status] Initial check...")
    print(f"[tracknet status] {_run_tracknet_status()}")
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

_offline_start_time = None
_offline_sim_lock = threading.Lock()

def _get_offline_released_segments(cam):
    global _offline_start_time
    with _offline_sim_lock:
        if _offline_start_time is None:
            _offline_start_time = time.time()
        sim_elapsed = (time.time() - _offline_start_time) * SPEED

    cam_ts_dir = os.path.join(DATA_DIR, f"ts_segments_{cam}", SESSION_ID)
    if not os.path.exists(cam_ts_dir):
        return [], 0, []

    all_files = sorted(os.listdir(cam_ts_dir))
    ts_files = [f for f in all_files if f.endswith(".ts")]
    if not ts_files:
        return [], 0, []

    start_seg = _args.start_segment
    if _args.start_frame is not None and cam in seg_to_frame:
        with _frame_idx_lock:
            for s_idx in sorted(seg_to_frame[cam].keys()):
                sf = seg_to_frame[cam][s_idx]
                fc = seg_frame_count[cam].get(s_idx, 120)
                if sf <= _args.start_frame < sf + fc:
                    start_seg = s_idx
                    break

    initial_count = 3
    additional = int(sim_elapsed / 4.0)
    total_count = initial_count + additional

    start_pos = 0
    for idx, f in enumerate(ts_files):
        s_idx = parse_abs_seg_idx(f)
        if s_idx is not None and s_idx >= start_seg:
            start_pos = idx
            break

    released = ts_files[start_pos : start_pos + total_count]
    if not released:
        released = ts_files[start_pos:]

    window = released[-WINDOW_SIZE:]
    first_window_seg_idx = parse_abs_seg_idx(window[0]) if window else start_seg
    media_sequence = first_window_seg_idx if first_window_seg_idx is not None else start_seg

    with _offline_sim_lock:
        for ts_name in window:
            if ts_name not in _logged_segments[cam]["loaded"]:
                print(f"[EVICTION LOGIC] Segment {ts_name} of {cam} loaded in server m3u8 playlist", flush=True)
                _logged_segments[cam]["loaded"].add(ts_name)

        window_set = set(window)
        for loaded_seg in list(_logged_segments[cam]["loaded"]):
            if loaded_seg not in window_set:
                if loaded_seg not in _logged_segments[cam]["removed"]:
                    print(f"[EVICTION LOGIC] Segment {loaded_seg} of {cam} removed from server m3u8 playlist (max {WINDOW_SIZE} segments)", flush=True)
                    _logged_segments[cam]["removed"].add(loaded_seg)

    return window, media_sequence, released


@app.get("/stream/{cam}/live.m3u8")
def get_live_m3u8(cam: str):
    from fastapi.responses import PlainTextResponse
    import os
    import urllib.request

    if cam not in ("source", "sink", "hq"):
        return PlainTextResponse("Camera not found", status_code=404)

    if _args.offline:
        window_files, media_sequence, _ = _get_offline_released_segments(cam)
        if not window_files:
            return PlainTextResponse(f"Directory not found or empty for camera {cam}", status_code=404)

        out_lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:4",
            "#EXT-X-TARGETDURATION:6",
            f"#EXT-X-MEDIA-SEQUENCE:{media_sequence}",
            "#EXT-X-ALLOW-CACHE:NO",
        ]

        host_port = f"http://localhost:{_args.port}"
        with _frame_idx_lock:
            for ts_name in window_files:
                seg_idx = parse_abs_seg_idx(ts_name)
                dur = 4.0
                if seg_idx is not None and seg_idx in seg_frame_count[cam]:
                    dur = seg_frame_count[cam][seg_idx] / FPS
                out_lines.append(f"#EXTINF:{dur:.6f},")
                out_lines.append(f"{host_port}/stream/{cam}/{ts_name}")

        return PlainTextResponse("\n".join(out_lines), media_type="application/vnd.apple.mpegurl")

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

    global _admitted_segments, _evicted_count

    # Maintain our own sliding window state starting from the last 3 segments
    if not _admitted_segments[cam]:
        # First poll: start with only 3 segments
        _admitted_segments[cam] = segments[-3:] if len(segments) >= 3 else segments
    else:
        # Subsequent polls: only append segments that are newer than our last admitted segment
        last_admitted_seg = _admitted_segments[cam][-1][1]
        last_idx = -1
        for j, item in enumerate(segments):
            if item[1] == last_admitted_seg:
                last_idx = j
                break
                
        if last_idx != -1 and last_idx + 1 < len(segments):
            for item in segments[last_idx + 1:]:
                _admitted_segments[cam].append(item)
        elif last_idx == -1:
            # If we fell so far behind that our last segment fell off the Pi's playlist entirely
            admitted_names = {seg for inf, seg, dur in _admitted_segments[cam]}
            for item in segments:
                if item[1] not in admitted_names:
                    _admitted_segments[cam].append(item)
    
    # Enforce WINDOW_SIZE limit and track evictions for the sequence number
    if len(_admitted_segments[cam]) > WINDOW_SIZE:
        evict_count = len(_admitted_segments[cam]) - WINDOW_SIZE
        _evicted_count[cam] += evict_count
        _admitted_segments[cam] = _admitted_segments[cam][-WINDOW_SIZE:]

    window_segments = _admitted_segments[cam]
    window_seg_names = {seg for inf, seg, dur in window_segments}

    for inf, seg, dur in window_segments:
        if seg not in _logged_segments[cam]["loaded"]:
            print(f"[EVICTION LOGIC] Segment {seg} of {cam} loaded in server m3u8 playlist")
            _logged_segments[cam]["loaded"].add(seg)
    
    for loaded_seg in list(_logged_segments[cam]["loaded"]):
        if loaded_seg not in window_seg_names:
            if loaded_seg not in _logged_segments[cam]["removed"]:
                print(f"[EVICTION LOGIC] Segment {loaded_seg} of {cam} removed from server m3u8 playlist (max {WINDOW_SIZE} segments)")
                _logged_segments[cam]["removed"].add(loaded_seg)

    out_lines = header_lines[:]
    
    # Update sequence number
    seq_idx = -1
    for idx, line in enumerate(out_lines):
        if line.startswith("#EXT-X-MEDIA-SEQUENCE"):
            seq_idx = idx
            break
            
    seq_num = _evicted_count[cam]
    if seq_idx != -1:
        out_lines[seq_idx] = f"#EXT-X-MEDIA-SEQUENCE:{seq_num}"
    else:
        out_lines.append(f"#EXT-X-MEDIA-SEQUENCE:{seq_num}")

    # Emit ABSOLUTE Pi segment URLs so HLS.js fetches each .ts directly from the
    # camera Pi instead of round-tripping through this server (serve_segment).
    # This removes the double hop (Pi -> server -> browser), halves WiFi bandwidth,
    # and keeps the FastAPI threadpool free for the lightweight playlist requests.
    # serve_segment remains as a fallback for relative-name playlists.
    base_url = cam_path.rsplit('/', 1)[0]
    for inf, seg, dur in window_segments:
        out_lines.append(inf)
        seg_name = seg.split("/")[-1]
        if seg.startswith("http://") or seg.startswith("https://"):
            out_lines.append(seg)
        else:
            out_lines.append(f"{base_url}/{SESSION_ID}/{seg_name}")
    return PlainTextResponse("\n".join(out_lines), media_type="application/vnd.apple.mpegurl")

from fastapi.responses import FileResponse, StreamingResponse

@app.get("/stream/{cam}/{segment}")
@app.get("/stream/{cam}/{segment}.ts")
def serve_segment(cam: str, segment: str):
    from fastapi.responses import Response, PlainTextResponse, FileResponse
    import urllib.request
    import time

    if _args.offline:
        ts_filename = segment if segment.endswith(".ts") else f"{segment}.ts"
        local_ts_path = os.path.join(DATA_DIR, f"ts_segments_{cam}", SESSION_ID, ts_filename)
        if os.path.exists(local_ts_path):
            return FileResponse(local_ts_path, media_type="video/mp2t", headers={"Cache-Control": "no-cache"})
        print(f"[serve_segment offline] File not found: {local_ts_path}")
        return PlainTextResponse(f"Segment not found locally: {ts_filename}", status_code=404)

    cam_path = CAM_PATHS.get(cam, "")
    if cam_path.startswith("http://") or cam_path.startswith("https://"):
        base_url = cam_path.rsplit('/', 1)[0]
        pi_url = f"{base_url}/{SESSION_ID}/{segment}.ts"

        max_retries = 6
        for attempt in range(max_retries):
            try:
                req = urllib.request.Request(pi_url, headers={'User-Agent': 'Mozilla/5.0'})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = resp.read()
                return Response(
                    content=data,
                    media_type="video/mp2t",
                    headers={"Cache-Control": "no-cache"}
                )
            except urllib.error.HTTPError as e:
                if e.code == 404 and attempt < max_retries - 1:
                    print(f"[serve_segment] 404 for {cam}/{segment}.ts. Retrying ({attempt+1}/{max_retries})...")
                    time.sleep(0.5)
                    continue
                else:
                    print(f"[serve_segment] Pi proxy HTTP error for {cam}/{segment}.ts: {e}")
                    return PlainTextResponse(f"Segment not available on Pi: {e}", status_code=502)
            except Exception as e:
                print(f"[serve_segment] Pi proxy fetch failed for {cam}/{segment}.ts: {e}")
                return PlainTextResponse(f"Segment not available on Pi: {e}", status_code=502)

    return PlainTextResponse("Camera path not found", status_code=404)

# For the bounce clips
BOUNCE_CLIPS_DIR = os.path.join(BASE_DIR, "clips", "cv_output", "bounce_clips")

@app.get("/clips/{cam}/{clip_name}")
def serve_bounce_clip(cam: str, clip_name: str):
    from fastapi.responses import FileResponse
    from fastapi import HTTPException
    import re

    if cam not in ("source", "sink", "hq"):
        raise HTTPException(status_code=400, detail="Invalid camera")
    if not re.fullmatch(r"(bounce|dirchange)_\d+_\d+\.mp4", clip_name):
        raise HTTPException(status_code=400, detail="Invalid clip name")

    if _args.offline:
        candidates = [
            os.path.join(CV_OUTPUT_DIR, "bounce_clips", cam, clip_name),
            os.path.join(ASSIGNMENT_DIR, "cv_output_july21", "bounce_clips", cam, clip_name),
            os.path.join(ASSIGNMENT_DIR, "cv_output", "bounce_clips", cam, clip_name),
            os.path.join(BOUNCE_CLIPS_DIR, cam, clip_name),
        ]
    else:
        candidates = [
            os.path.join(BOUNCE_CLIPS_DIR, cam, clip_name),
        ]

    for local_path in candidates:
        if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
            return FileResponse(local_path, media_type="video/mp4",
                                headers={"Cross-Origin-Resource-Policy": "cross-origin"})

    if _args.offline:
        raise HTTPException(status_code=404, detail=f"Clip not found locally: {clip_name}")

    remote_path = f"/home/jetson/Desktop/cv_output/bounce_clips/{cam}/{clip_name}"
    print(f"[serve_bounce_clip] Fetching {remote_path} from Jetson…")
    cmd = _ssh_argv(JETSON_HOST, f"cat {remote_path}")
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=60)
        if proc.returncode != 0:
            err = proc.stderr.decode(errors="replace").strip()
            print(f"[serve_bounce_clip] Not found: {remote_path} ({err})")
            raise HTTPException(status_code=404, detail=f"Clip not found on Jetson: {clip_name}")

        if not proc.stdout or len(proc.stdout) < 1024:
            print(f"[serve_bounce_clip] Empty/tiny file: {remote_path} ({len(proc.stdout)} bytes)")
            raise HTTPException(status_code=502, detail="Clip file empty on Jetson")

        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        with open(local_path, "wb") as f:
            f.write(proc.stdout)

        print(f"[serve_bounce_clip] Cached {clip_name} ({len(proc.stdout)} bytes)")
        return FileResponse(local_path, media_type="video/mp4",
                            headers={"Cross-Origin-Resource-Policy": "cross-origin"})
    except HTTPException:
        raise
    except Exception as e:
        print(f"[serve_bounce_clip] Error proxying {clip_name}: {e}")
        raise HTTPException(status_code=502, detail="Error fetching clip from Jetson")

# Local cache dir for trajectory clips
TRAJECTORY_CLIPS_DIR = os.path.join(BASE_DIR, "clips", "cv_output", "trajectory")

_graphics_lock = threading.Lock()
_graphics_state = {
    "loaded": False,
    "ready": False,
    "tracknet_forceful": "unknown",
}


def _graphics_poll_tracknet_off() -> tuple[bool, str]:
    """Poll TrackNet status; graphics is ready once source_sink_tracknet_forceful is off."""
    with _graphics_lock:
        if not _graphics_state["loaded"]:
            return False, _graphics_state["tracknet_forceful"]
        if _graphics_state["ready"]:
            return True, _graphics_state["tracknet_forceful"]

    raw = _run_tracknet_status()
    forceful = _parse_tracknet_forceful(raw)

    with _graphics_lock:
        if not _graphics_state["loaded"]:
            return False, forceful
        _graphics_state["tracknet_forceful"] = forceful
        if forceful == "off":
            _graphics_state["ready"] = True
            print("[graphics] TrackNet is off — analyse enabled")
        return _graphics_state["ready"], forceful


LOAD_GRAPHICS_WAIT_TIMEOUT = 120  # matches load_graphics SSH timeout


def _ensure_tracknet_off_for_analyse():
    """If TrackNet is not off, run load_graphics then wait until off before analyse proceeds."""
    from fastapi import HTTPException

    raw = _run_tracknet_status()
    forceful = _parse_tracknet_forceful(raw)
    print(f"[analyze_bounce] pre-check tracknet forceful={forceful}")

    if forceful == "off":
        with _graphics_lock:
            _graphics_state["loaded"] = True
            _graphics_state["ready"] = True
            _graphics_state["tracknet_forceful"] = "off"
        return

    # TrackNet still on (auto / unknown / anything else) — turn it off via load_graphics.
    with _graphics_lock:
        _graphics_state["loaded"] = True
        _graphics_state["ready"] = False
        _graphics_state["tracknet_forceful"] = forceful

    print(f"[analyze_bounce] TrackNet is '{forceful}' — running load_graphics_turnoff_source_sink.sh")
    _run_load_graphics_background()

    deadline = time.time() + LOAD_GRAPHICS_WAIT_TIMEOUT
    last = forceful
    while time.time() < deadline:
        ready, last = _graphics_poll_tracknet_off()
        if ready or last == "off":
            print("[analyze_bounce] TrackNet is off — continuing analyse")
            return
        time.sleep(1.0)

    raise HTTPException(
        status_code=409,
        detail=(
            f"TrackNet still '{last}' after load_graphics "
            f"({LOAD_GRAPHICS_WAIT_TIMEOUT}s). Analyse aborted."
        ),
    )


def _run_load_graphics_background():
    def _worker():
        cmd = f"cd {JETSON_CV_DIR} && ./load_graphics_turnoff_source_sink.sh"
        print(f"[graphics] Running (background): {cmd}")
        try:
            proc = subprocess.run(
                _ssh_argv(JETSON_HOST, cmd),
                capture_output=True, text=True, timeout=120,
            )
            if proc.stdout.strip():
                print(f"[graphics] load stdout:\n{proc.stdout.strip()}")
            if proc.returncode != 0:
                err = proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}"
                print(f"[graphics] load FAILED: {err}")
        except Exception as e:
            print(f"[graphics] load error: {e}")

    threading.Thread(target=_worker, daemon=True).start()


@app.post("/graphics/load")
def graphics_load():
    """Kick off load_graphics_turnoff_source_sink.sh once per review session (background)."""
    with _graphics_lock:
        _graphics_state["loaded"] = True
        _graphics_state["ready"] = False
        _graphics_state["tracknet_forceful"] = "unknown"
    print("[graphics] Review session load started — polling TrackNet until off")
    # _run_load_graphics_background()
    return {"status": "ok", "ready": False}


@app.post("/graphics/stop")
def graphics_stop():
    """Run stop_graphics.sh when leaving review / returning to live."""
    with _graphics_lock:
        was_loaded = _graphics_state["loaded"]
        _graphics_state["loaded"] = False
        _graphics_state["ready"] = False
        _graphics_state["tracknet_forceful"] = "unknown"

    if not was_loaded:
        print("[graphics] stop skipped — graphics was not loaded for this session")
        return {"status": "ok", "stopped": False}

    cmd = f"cd {JETSON_CV_DIR} && ./stop_graphics.sh"
    print(f"[graphics] Running: {cmd}")
    try:
        proc = subprocess.run(
            _ssh_argv(JETSON_HOST, cmd),
            capture_output=True, text=True, timeout=60,
        )
        if proc.stdout.strip():
            print(f"[graphics] stop stdout:\n{proc.stdout.strip()}")
        if proc.returncode != 0:
            err = proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}"
            print(f"[graphics] stop FAILED: {err}")
            from fastapi import HTTPException
            raise HTTPException(status_code=502, detail=f"stop_graphics failed: {err}")
    except subprocess.TimeoutExpired as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=504, detail=f"stop_graphics timed out: {e}")

    print("[graphics] stop complete")
    return {"status": "ok", "stopped": True}


@app.get("/graphics/status")
def graphics_status():
    ready, forceful = _graphics_poll_tracknet_off()
    with _graphics_lock:
        loaded = _graphics_state["loaded"]
    return {
        "loaded": loaded,
        "ready": ready,
        "tracknet_forceful": forceful,
    }

# How long run_graphics.sh is allowed to run end-to-end (queue wait + processing).
# There is intentionally no short ~2-minute cap: we let the script finish fully and
# only fetch the trajectory video once it has exited successfully.
RUN_GRAPHICS_SCRIPT_TIMEOUT = 1800   # passed to run_graphics.sh --timeout
RUN_GRAPHICS_SSH_TIMEOUT = 1900      # client-side ceiling, slightly above the script's

class AnalyzeBounceRequest(pydantic.BaseModel):
    csv_row: int                # 0-based data row in flight_shots.csv (run_graphics.sh arg)
    cameras: list = None        # if None/empty -> all three cameras (no --camera flag)
    # Legacy fields kept optional for logging / backward compatibility only.
    bounce_number: int = None
    bounce_frame: int = None

@app.post("/analyze_bounce")
def analyze_bounce(req: AnalyzeBounceRequest):
    """
    Runs status + run_graphics.sh for one flight_shots.csv row.

    If TrackNet is still on, runs load_graphics_turnoff_source_sink.sh first and
    waits until off, then continues with run_graphics.sh.
    stop_graphics.sh runs when returning to live.
    """
    from fastapi import HTTPException
    import json as _json

    valid_cams = ("hq", "sink", "source")
    requested = [c for c in (req.cameras or []) if c in valid_cams]
    cameras_to_run = requested if requested else list(valid_cams)
    # One run_graphics.sh invocation per requested camera (each with --camera), or a
    # single invocation with no --camera flag when running all cameras.
    run_targets = requested if requested else [None]

    if _args.offline:
        import glob
        clip_names = {}
        row_str = f"{req.csv_row:05d}"
        if os.path.isdir(TRAJECTORY_CLIPS_DIR):
            for cam in cameras_to_run:
                pattern = os.path.join(TRAJECTORY_CLIPS_DIR, f"bounce_{row_str}_{cam}_*motion*.mp4")
                matches = sorted(glob.glob(pattern))
                if matches:
                    clip_names[cam] = os.path.basename(matches[-1])
        if clip_names:
            print(f"[analyze_bounce offline] Found pre-rendered clip_names={clip_names} for csv_row={req.csv_row}")
            return {"status": "ok", "clip_names": clip_names}
        else:
            raise HTTPException(
                status_code=404,
                detail=f"No pre-rendered offline trajectory clip available for bounce row {req.csv_row}."
            )

    try:
        # Snapshot results.jsonl length so we can read only the entries this run produces.
        line_count_proc = subprocess.run(
            ssh_base + [f"wc -l < {results_path} 2>/dev/null || echo 0"],
            capture_output=True, text=True, timeout=10
        )
        prior_lines = int(line_count_proc.stdout.strip() or "0")
        print(f"[analyze_bounce] csv_row={req.csv_row} cameras={cameras_to_run} "
              f"(results.jsonl has {prior_lines} lines)")

        status_raw = _run_tracknet_status()
        print(f"[analyze_bounce] tracknet status:\n{status_raw}")

        # Run run_graphics.sh to completion (blocking). No 120s cap.
        run_errors = []
        for target in run_targets:
            cmd = (f"cd {JETSON_CV_DIR} && ./run_graphics.sh {SESSION_ID} {req.csv_row} "
                   f"--timeout {RUN_GRAPHICS_SCRIPT_TIMEOUT}")
            if target:
                cmd += f" --camera {target}"
            print(f"[analyze_bounce] Running: {cmd}")
            proc = subprocess.run(
                ssh_base + [cmd],
                capture_output=True, text=True, timeout=RUN_GRAPHICS_SSH_TIMEOUT
            )
            if proc.stdout.strip():
                print(f"[analyze_bounce] run_graphics stdout ({target or 'all'}):\n{proc.stdout.strip()}")
            if proc.returncode != 0:
                err = (proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}")
                print(f"[analyze_bounce] run_graphics FAILED ({target or 'all'}): {err}")
                run_errors.append(f"{target or 'all'}: {err}")

        # Read the new results.jsonl entries this run produced and pick ours.
        poll_proc = subprocess.run(
            ssh_base + [f"tail -n +{prior_lines + 1} {results_path} 2>/dev/null"],
            capture_output=True, text=True, timeout=15
        )
        result_entries = {}  # cam -> newest matching result entry
        for line in poll_proc.stdout.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = _json.loads(line)
            except Exception:
                continue
            cam = entry.get("camera")
            if cam in cameras_to_run and entry.get("csv_row") == req.csv_row:
                result_entries[cam] = entry  # later lines win (newest)
                print(f"[analyze_bounce] Got result for camera={cam}")

        if not result_entries:
            detail = "Graphics analysis produced no results."
            if run_errors:
                detail += " " + " | ".join(run_errors)
            raise HTTPException(status_code=502, detail=detail)

        # Download trajectory MP4 for each camera that succeeded
        os.makedirs(TRAJECTORY_CLIPS_DIR, exist_ok=True)
        clip_names = {}  # cam -> local clip filename
        for cam, entry in result_entries.items():
            # DEBUG: dump the full result entry so we can see exactly what the Jetson
            # returned (status, available keys, any error/reason field) when a camera
            # produces no downloadable trajectory video.
            print(f"[analyze_bounce] {cam} raw result entry: {_json.dumps(entry, default=str)}")
            if entry.get("status") != "ok":
                print(f"[analyze_bounce] Camera {cam} error: {entry.get('error', 'Unknown')}")
                continue
            remote_mp4 = entry.get("trajectory_motion_mp4_path") or entry.get("trajectory_fit_motion_mp4_path")
            if not remote_mp4:
                print(f"[analyze_bounce] Camera {cam}: no trajectory video path in result "
                      f"(keys present: {list(entry.keys())})")
                continue
            clip_name = os.path.basename(remote_mp4)
            local_path = os.path.join(TRAJECTORY_CLIPS_DIR, clip_name)
            print(f"[analyze_bounce] Fetching trajectory video for {cam}: {remote_mp4}")
            scp_proc = subprocess.run(
                ["ssh", "-i", SSH_KEY_PATH, "-o", "StrictHostKeyChecking=accept-new",
                 "-o", "BatchMode=yes", JETSON_HOST, f"cat {remote_mp4}"],
                capture_output=True, timeout=60
            )
            if scp_proc.returncode != 0:
                print(f"[analyze_bounce] Failed to fetch trajectory for {cam}: {scp_proc.stderr}")
                continue
            with open(local_path, "wb") as f:
                f.write(scp_proc.stdout)
            clip_names[cam] = clip_name
            print(f"[analyze_bounce] Saved trajectory for {cam}: {local_path}")

        if not clip_names:
            raise HTTPException(status_code=500, detail="All cameras failed to produce a trajectory video")

        print(f"[analyze_bounce] Done. clip_names={clip_names}")
        return {"status": "ok", "clip_names": clip_names}

    except HTTPException:
        raise
    except subprocess.TimeoutExpired as e:
        raise HTTPException(status_code=504, detail=f"SSH command timed out: {e}")
    except Exception as e:
        print(f"[analyze_bounce] Unexpected error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/trajectory_clip/{clip_name}")
def serve_trajectory_clip(clip_name: str):
    from fastapi.responses import FileResponse
    from fastapi import HTTPException
    import re

    # Names look like: bounce_00004_source_6782_trajectory_fit_motion.mp4
    m = re.fullmatch(r"bounce_\d+_(source|sink|hq)_\d+_[A-Za-z0-9_]+\.mp4", clip_name)
    if not m:
        raise HTTPException(status_code=400, detail="Invalid trajectory clip name")
    cam = m.group(1)

    local_path = os.path.join(TRAJECTORY_CLIPS_DIR, clip_name)
    if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
        return FileResponse(local_path, media_type="video/mp4",
                            headers={"Cross-Origin-Resource-Policy": "cross-origin"})

    # Not cached locally — pull it from the Jetson on demand (mirrors serve_bounce_clip),
    # so trajectory clips survive a wiped local cache without needing a re-analyse.
    remote_path = f"/home/jetson/Desktop/cv_output/bounce_clips/tracknet/{cam}/motion/{clip_name}"
    print(f"[serve_trajectory_clip] Fetching {remote_path} from Jetson…")
    try:
        proc = subprocess.run(_ssh_argv(JETSON_HOST, f"cat {remote_path}"),
                              capture_output=True, timeout=60)
        if proc.returncode != 0:
            err = proc.stderr.decode(errors="replace").strip()
            print(f"[serve_trajectory_clip] Not found: {remote_path} ({err})")
            raise HTTPException(status_code=404, detail=f"Trajectory clip not found: {clip_name}")
        if not proc.stdout or len(proc.stdout) < 1024:
            print(f"[serve_trajectory_clip] Empty/tiny file: {remote_path} ({len(proc.stdout)} bytes)")
            raise HTTPException(status_code=502, detail="Trajectory clip empty on Jetson")

        os.makedirs(TRAJECTORY_CLIPS_DIR, exist_ok=True)
        with open(local_path, "wb") as f:
            f.write(proc.stdout)
        print(f"[serve_trajectory_clip] Cached {clip_name} ({len(proc.stdout)} bytes)")
        return FileResponse(local_path, media_type="video/mp4",
                            headers={"Cross-Origin-Resource-Policy": "cross-origin"})
    except HTTPException:
        raise
    except Exception as e:
        print(f"[serve_trajectory_clip] Error proxying {clip_name}: {e}")
        raise HTTPException(status_code=502, detail="Error fetching trajectory clip from Jetson")


@app.get("/trajectory_clips")
def list_trajectory_clips(bounce_frame: int):
    """Return trajectory clips that exist for a given bounce, keyed by camera. Lets the
    frontend restore previously-analysed graphics when navigating back to a bounce instead
    of forcing a re-analyse. Files are named bounce_<NNNNN>_<cam>_<bounce_frame>_..._motion.mp4.

    Checks the local cache first; for any camera not cached locally, falls back to listing
    the Jetson so a wiped local cache still restores (the serve route pulls on demand).
    """
    import glob
    import re

    clip_names = {}
    # 1) Local cache (underscore-delimited bounce_frame avoids matching 14578 in 145780).
    if os.path.isdir(TRAJECTORY_CLIPS_DIR):
        for cam in ("source", "sink", "hq"):
            pattern = os.path.join(TRAJECTORY_CLIPS_DIR,
                                   f"bounce_*_{cam}_{bounce_frame}_*motion*.mp4")
            matches = sorted(glob.glob(pattern))
            if matches:
                clip_names[cam] = os.path.basename(matches[-1])

    # 2) Jetson fallback for any camera still missing.
    missing = [c for c in ("source", "sink", "hq") if c not in clip_names]
    if missing:
        try:
            base = "/home/jetson/Desktop/cv_output/bounce_clips/tracknet"
            remote_cmd = "; ".join(
                f"ls {base}/{cam}/motion/bounce_*_{cam}_{bounce_frame}_*motion*.mp4 2>/dev/null"
                for cam in missing
            )
            proc = subprocess.run(_ssh_argv(JETSON_HOST, remote_cmd),
                                  capture_output=True, text=True, timeout=15)
            found = {}
            for path in proc.stdout.strip().splitlines():
                name = os.path.basename(path.strip())
                m = re.fullmatch(r"bounce_\d+_(source|sink|hq)_\d+_[A-Za-z0-9_]+\.mp4", name)
                if m:
                    found[m.group(1)] = name  # later (sorted by ls) wins
            for cam, name in found.items():
                clip_names.setdefault(cam, name)
        except Exception as e:
            print(f"[list_trajectory_clips] Jetson fallback failed: {e}")

    return {"clip_names": clip_names}


@app.get("/tracknet_status")
def get_tracknet_status():
    raw = _run_tracknet_status()
    forceful = _parse_tracknet_forceful(raw)
    print(f"[tracknet status] {raw}")
    return {"forceful": forceful, "raw": raw}


class TracknetSetRequest(pydantic.BaseModel):
    mode: str  # "off" or "auto"

@app.post("/tracknet_set")
def set_tracknet(req: TracknetSetRequest):
    from fastapi import HTTPException
    if req.mode not in ("off", "auto"):
        raise HTTPException(status_code=400, detail="mode must be 'off' or 'auto'")

    if _args.offline:
        return {"status": "ok", "forceful": req.mode, "raw": "offline mode"}

    cmd = f"cd /home/jetson/Desktop/judex-cv && python3 tracknet_control.py set source_sink_tracknet_forceful {req.mode}"
    print(f"[tracknet set] Sending: forceful={req.mode}")
    result = subprocess.run(
        _ssh_argv(JETSON_HOST, cmd),
        capture_output=True, text=True, timeout=15
    )
    if result.returncode != 0:
        print(f"[tracknet set] Error: {result.stderr}")
        raise HTTPException(status_code=502, detail=f"Failed to set mode: {result.stderr}")

    print(f"[tracknet set] Command sent. Confirming with status...")
    raw = _run_tracknet_status()
    forceful = _parse_tracknet_forceful(raw)
    print(f"[tracknet status] {raw}")
    print(f"[tracknet set] Confirmed forceful={forceful}")
    return {"status": "ok", "forceful": forceful, "raw": raw}


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
            res[target_cam] = {"segment": from_seg, "offset": from_offset, "frame": current_frame, "searched_frame": current_frame, "exact": True}
            continue
            
        if target_cam == "hq" and current_frame in _missing_hq_frames:
            print(f"Warning: HQ sync not possible for {from_camera} frame {current_frame} (MISSING_HQ in triple.csv)")
            
        map_key = f"{from_camera}_to_{target_cam}"
        exact = current_frame in sync_maps[map_key]
        if exact:
            target_frame = sync_maps[map_key][current_frame]
            
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
                "searched_frame": current_frame,
                "exact": True
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
                    seg_res[target_cam] = {"segment": sn, "offset": 0.0, "frame": start_frame, "searched_frame": start_frame, "exact": True}
                    continue
                    
                if target_cam == "hq" and start_frame in _missing_hq_frames:
                    print(f"Warning: HQ sync map not possible for {from_camera} segment {sn} (MISSING_HQ in triple.csv)")
                    continue
                    
                map_key = f"{from_camera}_to_{target_cam}"
                exact = start_frame in sync_maps[map_key]
                if exact:
                    target_frame = sync_maps[map_key][start_frame]
                    
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
                        "searched_frame": start_frame,
                        "exact": True
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
                expected = raw_expected
                diff = abs(frames[target] - expected)
                checks[key] = {
                    "anchor_frame": anchor_frame,
                    "expected_target_frame": expected,
                    "actual_target_frame": frames[target],
                    "diff_frames": diff,
                    "exact_hit": True,
                    "match": diff <= tolerance,
                }
            else:
                checks[key] = {
                    "anchor_frame": anchor_frame,
                    "expected_target_frame": None,
                    "actual_target_frame": frames[target],
                    "diff_frames": None,
                    "exact_hit": False,
                    "match": False,
                    "error": "not in triple.csv"
                }

    overall = all(c.get("match", False) for c in checks.values())
    return {"frames": frames, "checks": checks, "overall_match": overall, "tolerance": tolerance}

@app.get("/events")
def get_events():
    # Lazily pull any new flight shots from the Jetson — only happens when the
    # frontend asks for events (review mode), not continuously during live playback.
    _refresh_flight_shots()
    with _events_lock, _sync_lock, _frame_idx_lock:
        refreshed = [_refresh_event_positions(ev) for ev in _events_by_id.values()]

        max_released_seg = {}
        for cam in ["source", "sink", "hq"]:
            if _args.offline:
                _, _, released = _get_offline_released_segments(cam)
                if released:
                    max_released_seg[cam] = parse_abs_seg_idx(released[-1])
                else:
                    max_released_seg[cam] = -1
            else:
                admitted = _admitted_segments[cam]
                if admitted:
                    max_released_seg[cam] = parse_abs_seg_idx(admitted[-1][1])
                else:
                    max_released_seg[cam] = -1

        # Filter events so Review Mode ONLY displays events from segments loaded in live mode
        by_bounce = {}
        for ev in refreshed:
            segs = ev.get("segments")
            if segs and isinstance(segs, dict):
                is_loaded = True
                for cam, seg_idx in segs.items():
                    if seg_idx is not None and max_released_seg.get(cam) is not None:
                        if max_released_seg[cam] != -1 and seg_idx > max_released_seg[cam]:
                            is_loaded = False
                            break
                if not is_loaded:
                    continue

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

class PrefetchRequest(pydantic.BaseModel):
    bounce_frames: List[int]

@app.post("/prefetch_bounces")
def prefetch_bounces(req: PrefetchRequest):
    """Prefetch bounce clips from Jetson for the given HQ frames."""
    print(f"Prefetching {len(req.bounce_frames)} bounce clips...")
    if not req.bounce_frames:
        return {"status": "ok"}
        
    if _args.offline:
        return {"status": "ok", "message": "Bounce clips available locally in offline mode"}
        
    def _download_worker():
        import threading
        
        # Build list of patterns
        patterns = []
        for bf in req.bounce_frames:
            patterns.append(f"bounce_{bf}_*.mp4")
            
        if not patterns: return
        
        # We need to run find/scp for all cameras.
        for cam in ["source", "sink", "hq"]:
            try:
                # Find the files on jetson
                find_args = " -o ".join([f"-name '{p}'" for p in patterns])
                remote_dir = f"/home/jetson/Desktop/cv_output/bounce_clips/{cam}"
                ls_cmd = ["ssh", "-i", SSH_KEY_PATH, "-o", "StrictHostKeyChecking=accept-new", "jetson@192.168.0.148", f"find {remote_dir} -type f \\( {find_args} \\)"]
                
                res = subprocess.run(ls_cmd, capture_output=True, text=True)
                files = [f for f in res.stdout.split('\n') if f.strip()]
                
                if files:
                    # SCP them over
                    local_dir = os.path.join(BOUNCE_CLIPS_DIR, cam)
                    os.makedirs(local_dir, exist_ok=True)
                    
                    scp_cmd = ["scp", "-i", SSH_KEY_PATH, "-o", "StrictHostKeyChecking=accept-new"]
                    scp_cmd.extend([f"jetson@192.168.0.148:{f}" for f in files])
                    scp_cmd.append(local_dir)
                    
                    print(f"[{cam}] Downloading {len(files)} bounce clips...")
                    subprocess.run(scp_cmd, capture_output=True)
            except Exception as e:
                print(f"Prefetch error for {cam}: {e}")
                
    threading.Thread(target=_download_worker, daemon=True).start()
    return {"status": "started"}

@app.post("/clear_bounces")
def clear_bounces():
    import shutil
    try:
        if os.path.exists(BOUNCE_CLIPS_DIR):
            print("Clearing local bounce clips cache...")
            shutil.rmtree(BOUNCE_CLIPS_DIR)
            os.makedirs(BOUNCE_CLIPS_DIR, exist_ok=True)
    except Exception as e:
        print(f"Error clearing bounce clips: {e}")
    return {"status": "ok"}

if __name__ == "__main__":
    print(f"Starting server on port {_args.port} at {SPEED}x speed (session {SESSION_ID}).")
    uvicorn.run(app, host="0.0.0.0", port=_args.port, log_level="error")
