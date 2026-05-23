import re

with open('player/src/components/SeekBar.jsx', 'r') as f:
    content = f.read()

# Change rangeEnd to NOT include segsEnd if we are in live mode, so the liveEdge is the absolute visual right side
pattern = r'const rangeEnd = Math\.max\(segsEnd \?\? -Infinity, liveEdge \?\? -Infinity, currentTime\)'
repl = r'const rangeEnd = mode === "live" && liveEdge !== null ? Math.max(liveEdge, currentTime) : Math.max(segsEnd ?? -Infinity, liveEdge ?? -Infinity, currentTime)'

new_content = re.sub(pattern, repl, content)

with open('player/src/components/SeekBar.jsx', 'w') as f:
    f.write(new_content)

print("SeekBar patched")
