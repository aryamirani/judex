import re

with open('player/src/App.jsx', 'r') as f:
    content = f.read()

pattern = r'const LIVE_CONFIG = \{.*?\}'
repl = r'const LIVE_CONFIG = { backBufferLength: 150, maxBufferLength: 150, liveSyncDurationCount: 1, liveMaxLatencyDurationCount: 2, enableWorker: true }'

new_content = re.sub(pattern, repl, content)

with open('player/src/App.jsx', 'w') as f:
    f.write(new_content)

print("HLS Config Patched")
