import re

with open('tri_stream_server2.py', 'r') as f:
    content = f.read()

pattern = r'(app = FastAPI\(\)\n\n)(app\.add_middleware)'
repl = r"""\1from fastapi import Response, HTTPException

@app.get("/stream/{cam}/live.m3u8")
async def get_live_playlist(cam: str):
    path = os.path.join(BASE_DIR, "serve", cam, "live.m3u8")
    if not os.path.exists(path):
        raise HTTPException(status_code=404)
    with open(path, "rb") as f:
        content = f.read()
    return Response(content=content, media_type="application/vnd.apple.mpegurl")

\2"""

new_content = re.sub(pattern, repl, content)

with open('tri_stream_server2.py', 'w') as f:
    f.write(new_content)

print("Routes patched")
