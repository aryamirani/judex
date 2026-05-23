import sys

with open('player/src/App.jsx', 'r') as f:
    content = f.read()

content = content.replace("if (Math.abs(delta) > 0.1) {", "if (Math.abs(delta) > 0.1) { console.log('SHIFTING TIMELINE DELTA:', delta);")

with open('player/src/App.jsx', 'w') as f:
    f.write(content)

