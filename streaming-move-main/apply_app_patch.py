import sys

file_path = "/Users/aryamirani/Desktop/intern/judex/streaming-move-main/player/src/App.jsx"
with open(file_path, "r") as f:
    content = f.read()

# Fix getAllCamPositions
wrong_getall = """  const getAllCamPositions = useCallback(() => {
    const pos = {}
    CAMERAS.forEach(cam => {
      const liveConfig = { ...LIVE_CONFIG }
      if (cam !== activeCamRef.current) {
        liveConfig.liveMaxLatencyDurationCount = 9999
      }
      const hls = hlsRefs[cam].current
      const video = videoRefs[cam].current"""

correct_getall = """  const getAllCamPositions = useCallback(() => {
    const pos = {}
    CAMERAS.forEach(cam => {
      const hls = hlsRefs[cam].current
      const video = videoRefs[cam].current"""

content = content.replace(wrong_getall, correct_getall)

# Fix initLive
wrong_initlive = """  const initLive = useCallback(() => {
    setIsPlaying(true)
    CAMERAS.forEach(cam => {
      const video = videoRefs[cam].current
      if (!video) return

      const hls = new Hls(LIVE_CONFIG)"""

correct_initlive = """  const initLive = useCallback(() => {
    setIsPlaying(true)
    CAMERAS.forEach(cam => {
      const video = videoRefs[cam].current
      if (!video) return

      const liveConfig = { ...LIVE_CONFIG }
      if (cam !== activeCamRef.current) {
        liveConfig.liveMaxLatencyDurationCount = 9999
      }
      const hls = new Hls(liveConfig)"""

content = content.replace(wrong_initlive, correct_initlive)

with open(file_path, "w") as f:
    f.write(content)

print("App patch applied successfully.")
