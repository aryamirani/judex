# Triple-Camera Live Review System

A professional, broadcast-grade sports review interface featuring synchronized triple-camera live streams, instant camera switching, interactive event navigation, and an offline, zero-network VOD review mode.

## Setup Instructions

### Prerequisites & Dependencies
* **Backend:** Python 3.9+
  * Core dependencies: `fastapi`, `uvicorn`, `pandas`
* **Frontend:** Node.js (v16+)
  * Core dependencies: `react`, `vite`, `hls.js`

### Installation Steps

1. **Backend Setup (Python):**
   ```bash
   cd streaming-move-main
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```

2. **Frontend Setup (Node):**
   ```bash
   cd streaming-move-main/player
   npm install
   ```

### Media Assets & Data Folders
Because raw media files and heavy folders (`.ts`, `.mp4`, `bounce_clips_share/`, etc.) are ignored via `.gitignore`, you must manually download and place them into the root of this repository before running the server. 

Your root directory should look exactly like this:

```text
├── sync_reports/
│   ├── ts_segments_hq/1645/     # Place HQ .ts chunks and playlist.m3u8 here
│   ├── ts_segments_sink/1645/   # Place SINK .ts chunks and playlist.m3u8 here
│   └── ts_segments_source/1645/ # Place SOURCE .ts chunks and playlist.m3u8 here
├── bounce_clips_share/
│   ├── hq/                      # Place HQ bounce_*.mp4 clips here
│   ├── sink/                    # Place SINK bounce_*.mp4 clips here
│   └── source/                  # Place SOURCE bounce_*.mp4 clips here
```

*(Note: The `streaming-move-main/serve/` directory is **automatically generated** by the backend at runtime. You do not need to create it or download anything into it.)*

---

## Running the Application

You need to run both the backend server and the frontend client simultaneously.

### 1. Start the Backend Server
This single FastAPI server simulates the live rolling HLS windows, computes $O(1)$ synchronization lookups, and serves the static MP4 clips.
```bash
cd streaming-move-main
source venv/bin/activate
python3 tri_stream_server.py --port 8000
```

### 2. Start the Frontend Application
In a new terminal window, start the React/Vite app:
```bash
cd streaming-move-main/player
npm run dev
```
The interface will be accessible at `http://localhost:3000`.

---

## Architectural & Technical Assumptions Made

As outlined in the master implementation plan, the following architectural assumptions govern the system's behavior:

1. **Constant Frame Rate:** The playback synchronization assumes a constant frame rate of **30 FPS** for all three cameras. Time offsets and seeks are calculated based on this assumption.
2. **Sync Granularity:** Synchronization across the SOURCE, SINK, and HQ feeds is handled via frame-number interpolation mappings (provided in the CSVs) to ensure strict frame-level accuracy, rather than approximate sub-frame accuracy.
3. **Review Mode Scope:** The "Review Mode" functions as a rolling DVR. It relies on an `ArrayBuffer` interception map and captures only the segments that have successfully streamed over the network *during the active live session*.
4. **Local Media Storage:** Pre-rendered `bounce_*.mp4` clips are assumed to reside on the local filesystem and are served via a static FastAPI mount, mapping directly to flight IDs and bounce frames.
5. **Unified Application Server:** The baseline `main.py` simulated progressive release script has been thoroughly expanded and merged into `tri_stream_server.py`. The resulting server simultaneously handles the sliding HLS playlists, TS chunk distribution, and the custom `/sync_map` APIs in a single, high-performance async process.
