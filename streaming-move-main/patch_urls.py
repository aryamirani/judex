import re

with open('player/src/App.jsx', 'r') as f:
    content = f.read()

pattern = r'const useLocalStream = typeof window !== \'undefined\' && \(window\.location\.hostname === \'localhost\' \|\| window\.location\.hostname === \'127\.0\.0\.1\'\);\nconst CAM_STREAM_URLS = \{\n  source: useLocalStream \? \'http://localhost:8000/stream/source/live\.m3u8\' : \'http://192\.168\.0\.111:8083/live\.m3u8\',\n  sink:   useLocalStream \? \'http://localhost:8000/stream/sink/live\.m3u8\' : \'http://192\.168\.0\.113:8083/live\.m3u8\',\n  hq:     useLocalStream \? \'http://localhost:8000/stream/hq/live\.m3u8\' : \'http://192\.168\.0\.112:8083/live\.m3u8\',\n\}'

repl = r"""const backendUrl = typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.hostname}:8000` : 'http://localhost:8000';
const CAM_STREAM_URLS = {
  source: `${backendUrl}/stream/source/live.m3u8`,
  sink:   `${backendUrl}/stream/sink/live.m3u8`,
  hq:     `${backendUrl}/stream/hq/live.m3u8`,
}"""

new_content = re.sub(pattern, repl, content)

with open('player/src/App.jsx', 'w') as f:
    f.write(new_content)

print("URLs patched")
