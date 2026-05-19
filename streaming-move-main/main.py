#!/usr/bin/env python3
"""
Simulates a live HLS stream from the hello1 folder.

Writes a real live.m3u8 file on disk, appending one entry at a time
as each segment becomes "available". The HTTP server just serves files
from the serve/ directory.
"""

import os
import time
import shutil
import threading
import argparse
from http.server import HTTPServer, SimpleHTTPRequestHandler

SOURCE_DIR  = os.path.join(os.path.dirname(__file__), "hello1")
SERVE_DIR   = os.path.join(os.path.dirname(__file__), "serve")
PLAYLIST    = os.path.join(SERVE_DIR, "live.m3u8")
WINDOW_SIZE = 30
PORT        = 8080


def parse_playlist(path):
    """Return list of (duration_float, segment_filename)."""
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


def write_playlist(window, media_sequence, done=False):
    """Rewrite live.m3u8 with the current sliding window of segments."""
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:6",
        f"#EXT-X-MEDIA-SEQUENCE:{media_sequence}",
    ]
    for duration, name in window:
        lines.append(f"#EXTINF:{duration:.6f},")
        lines.append(name)
    if done:
        lines.append("#EXT-X-ENDLIST")
    with open(PLAYLIST, "w") as f:
        f.write("\n".join(lines) + "\n")


def stream_loop(segments, window_size, speed):
    """Add one segment entry at a time to live.m3u8 at real-time pace."""
    total = len(segments)
    released = []
    media_sequence = 0

    for i, (duration, name) in enumerate(segments):
        released.append((duration, name))

        # copy segment file into serve/ if not already there
        src = os.path.join(SOURCE_DIR, name)
        dst = os.path.join(SERVE_DIR, name)
        if not os.path.exists(dst):
            shutil.copy2(src, dst)

        # slide the window and advance media sequence
        if len(released) > window_size:
            media_sequence += 1
        window = released[-window_size:]

        is_last = (i == total - 1)
        write_playlist(window, media_sequence, done=is_last)

        print(f"  [{i+1:>4}/{total}]  added {name}  ({duration:.2f}s)  "
              f"seq={media_sequence}  window={len(window)}")

        time.sleep(duration / speed)

    print("\nAll segments written — #EXT-X-ENDLIST added.")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SERVE_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Cache-Control", "no-cache, no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        msg = fmt % args
        if ".ts" in msg:
            print(f"  fetched: {self.path}")


def main():
    parser = argparse.ArgumentParser(description="Live HLS simulator from hello1/")
    parser.add_argument("--port",    type=int,   default=PORT)
    parser.add_argument("--speed",   type=float, default=1.0,
                        help="Speed multiplier (e.g. 4.0 = 4x faster)")
    parser.add_argument("--window",  type=int,   default=WINDOW_SIZE,
                        help="Sliding window size (number of segments in playlist)")
    args = parser.parse_args()

    # fresh serve directory each run
    if os.path.exists(SERVE_DIR):
        shutil.rmtree(SERVE_DIR)
    os.makedirs(SERVE_DIR)

    all_segs = parse_playlist(os.path.join(SOURCE_DIR, "playlist.m3u8"))
    available = [(d, n) for d, n in all_segs
                 if os.path.isfile(os.path.join(SOURCE_DIR, n))]
    print(f"Found {len(available)} segments in hello1/\n")

    # write an initial empty playlist so VLC doesn't 404 on connect
    write_playlist([], media_sequence=0)

    server = HTTPServer(("", args.port), Handler)

    t = threading.Thread(
        target=stream_loop,
        args=(available, args.window, args.speed),
        daemon=True,
    )
    t.start()

    print(f"Stream URL  →  http://localhost:{args.port}/live.m3u8")
    print(f"Speed: {args.speed}x  |  Window: {args.window} segments")
    print("Open in VLC:  File → Open Network  (Cmd+N)\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")


if __name__ == "__main__":
    main()
