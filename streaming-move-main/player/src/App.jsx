import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import Hls from 'hls.js'
import SeekBar from './components/SeekBar.jsx'
import LiveBadge from './components/LiveBadge.jsx'
import CameraSelector from './components/CameraSelector.jsx'
import EventPanel from './components/EventPanel.jsx'

const REVIEW_BUFFER_SIZE = 30
const LIVE_THRESHOLD = 2

const LIVE_CONFIG = {
  enableWorker: true,
  lowLatencyMode: true,
  backBufferLength: 250, // Safely accommodates 30 segments of variable lengths (e.g. 5-6s each)
  liveSyncDurationCount: 1,
  liveMaxLatencyDurationCount: 1.5,
  liveDurationRatio: 1,
  manifestLoadingMaxRetry: 100,
  manifestLoadingRetryDelay: 500,
  maxBufferLength: 250,
  maxMaxBufferLength: 250,
  maxBufferSize: 500 * 1024 * 1024 // 500 MB limit to prevent bitrate bottlenecks
}
const REVIEW_CONFIG = { enableWorker: true, maxBufferLength: 150, backBufferLength: 150 }

const CAMERAS = ['source', 'sink', 'hq']
const backendUrl = typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.hostname}:8000` : 'http://localhost:8000';
const CAM_STREAM_URLS = {
  source: `${backendUrl}/stream/source/live.m3u8`,
  sink: `${backendUrl}/stream/sink/live.m3u8`,
  hq: `${backendUrl}/stream/hq/live.m3u8`,
}

function buildReviewPlaylist(segments, blobUrls) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD']
  for (let i = 0; i < segments.length; i++) {
    lines.push(`#EXTINF:${segments[i].duration.toFixed(6)},`, blobUrls[i])
  }
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n')
}

export default function App() {
  const videoRefs = { source: useRef(null), sink: useRef(null), hq: useRef(null) }
  const hlsRefs = { source: useRef(null), sink: useRef(null), hq: useRef(null) }
  const rollingBuffers = { source: useRef([]), sink: useRef([]), hq: useRef([]) }
  const blobUrlsRef = useRef([])
  const segmentStartTimesRef = useRef({ source: {}, sink: {}, hq: {} })
  const downloadingSegmentsRef = useRef({ source: new Set(), sink: new Set(), hq: new Set() })

  const rafRef = useRef(null)
  const modeRef = useRef('live')
  const lastTickRef = useRef(performance.now())
  const liveEdgeRef = useRef(null)

  const [activeCam, setActiveCam] = useState('hq')
  const [mode, setMode] = useState('live')
  const [status, setStatus] = useState('connecting')
  const [events, setEvents] = useState([])

  // UI State for Active Camera
  const [currentTime, setCurrentTime] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1.0)
  const [liveEdge, setLiveEdge] = useState(null)
  const [bufferStart, setBufferStart] = useState(null)
  const [bufferedEnd, setBufferedEnd] = useState(null)
  const [liveSegments, setLiveSegments] = useState([])
  const [reviewSegs, setReviewSegs] = useState({ source: [], sink: [], hq: [] })
  const [syncMap, setSyncMap] = useState(null)
  const [liveSyncMap, setLiveSyncMap] = useState({})
  const [selectedEvent, setSelectedEvent] = useState(null)
  const [isPlaying, setIsPlaying] = useState(true)

  const handleTogglePlay = useCallback(() => {
    setIsPlaying(prev => {
      const nextPlaying = !prev
      CAMERAS.forEach(cam => {
        const video = videoRefs[cam].current
        if (video) {
          if (nextPlaying) {
            if (modeRef.current === 'review') {
              // In review mode (local Blob URLs), play all cameras to keep them perfectly in sync in the background
              video.play().catch(e => console.log('play failed', e))
            } else if (cam === activeCamRef.current) {
              // In live mode, only play the active camera to save Wi-Fi bandwidth
              video.play().catch(e => console.log('play failed', e))
            }
            // Resuming: check if we're at the live edge — if so, re-enable latency enforcement
            if (modeRef.current === 'live') {
              const hls = hlsRefs[cam].current
              const livePos = hls?.liveSyncPosition
              const isAtLive = livePos && Math.abs(video.currentTime - livePos) < 2.0
              if (hls) {
                hls.config.liveMaxLatencyDurationCount = isAtLive ? LIVE_CONFIG.liveMaxLatencyDurationCount : 9999
              }
            }
          } else {
            video.pause()
            // Pausing: disable latency enforcement so HLS.js won't drag us to live edge
            if (modeRef.current === 'live') {
              const hls = hlsRefs[cam].current
              if (hls) hls.config.liveMaxLatencyDurationCount = 9999
            }
          }
        }
      })
      return nextPlaying
    })
  }, [])

  const activeCamRef = useRef(activeCam)
  const cutoffAbsSegIdxRef = useRef({ source: -1, sink: -1, hq: -1 })
  const ignoreSyncRef = useRef(false)
  const [gapState, setGapState] = useState({ source: false, sink: false, hq: false })

  useEffect(() => {
    activeCamRef.current = activeCam
    if (mode === 'live') {
      const buf = rollingBuffers[activeCam].current
      setLiveSegments(buf.map(s => ({
        sn: s.sn,
        absSegIdx: s.absSegIdx,
        start: s.originalStart,
        end: s.originalStart + s.duration
      })))
    }
  }, [activeCam, mode])

  useEffect(() => {
    if (mode === 'live' && liveSegments.length > 0) {
      const absSns = liveSegments.map(s => s.absSegIdx).filter(x => x !== undefined).join(',')
      if (absSns) {
        fetch(`${backendUrl}/sync_map?from_camera=${activeCam}&sns=${absSns}`)
          .then(res => res.json())
          .then(data => setLiveSyncMap(data))
          .catch(e => console.warn('Failed to fetch live sync map', e))
      }
    }
  }, [activeCam, mode, liveSegments])

  const isLive = mode === 'live' && liveEdge !== null && currentTime >= liveEdge - LIVE_THRESHOLD

  const fetchEvents = async () => {
    try {
      const res = await fetch(`${backendUrl}/events`)
      const data = await res.json()
      setEvents(data)
    } catch (e) { console.warn('Failed to fetch events', e) }
  }

  useEffect(() => {
    fetchEvents()
    const interval = setInterval(fetchEvents, 5000)
    return () => clearInterval(interval)
  }, [])

  const mappedEvents = useMemo(() => {
    const currentSegs = mode === 'live' ? liveSegments : reviewSegs[activeCam]
    if (!currentSegs || currentSegs.length === 0) {
      return events.map(ev => ({
        ...ev,
        time: (ev.segments?.[activeCam] ?? 0) * 6.0 + (ev.offsets?.[activeCam] ?? 0),
        startTime: (ev.start_segments?.[activeCam] ?? 0) * 6.0 + (ev.start_offsets?.[activeCam] ?? 0),
        endTime: (ev.end_segments?.[activeCam] ?? 0) * 6.0 + (ev.end_offsets?.[activeCam] ?? 0)
      }))
    }
    const anchor = currentSegs[0]
    return events.map(ev => {
      const getPlaybackTime = (segs, offs) => {
        const segNum = segs?.[activeCam] ?? 0
        const offset = offs?.[activeCam] ?? 0

        // 1. In live mode, try to use exact historical start time to prevent jitter
        if (mode === 'live') {
          const exactStart = segmentStartTimesRef.current?.[activeCam]?.[segNum]
          if (exactStart !== undefined) {
            return exactStart + offset
          }
        }

        // 2. Fallback to current sliding window segments
        const matchingSeg = currentSegs.find(s => s.absSegIdx === segNum)
        if (matchingSeg) {
          return matchingSeg.start + offset
        }

        // 3. Last resort: estimate from anchor
        return anchor.start + (segNum - (anchor.absSegIdx ?? anchor.sn)) * 6.0 + offset
      }

      return {
        ...ev,
        time: getPlaybackTime(ev.segments, ev.offsets),
        startTime: getPlaybackTime(ev.start_segments, ev.start_offsets),
        endTime: getPlaybackTime(ev.end_segments, ev.end_offsets)
      }
    })
  }, [events, activeCam, mode, liveSegments, reviewSegs])

  const syncReviewVideos = useCallback((activeTime) => {
    if (!syncMap) return
    const activeList = reviewSegs[activeCam]
    if (!activeList || activeList.length === 0) return

    const activeSeg = activeList.find(s => activeTime >= s.start && activeTime <= s.end)
    if (!activeSeg) return

    let sourceOffsetInSeg = activeTime - activeSeg.start
    const sn = activeSeg.absSegIdx

    // Normalize offset back to source baseline
    const activeMapping = syncMap[sn]?.[activeCam]
    if (activeMapping) {
      sourceOffsetInSeg -= activeMapping.offset
    }

    CAMERAS.forEach(cam => {
      if (cam === activeCam) return
      const mapping = syncMap[sn]?.[cam]
      if (!mapping) return

      const targetList = reviewSegs[cam]
      if (!targetList) return
      const targetSeg = targetList.find(s => s.absSegIdx === mapping.segment)
      if (targetSeg) {
        const targetTime = targetSeg.start + sourceOffsetInSeg + mapping.offset
        const targetVideo = videoRefs[cam].current
        if (targetVideo) {
          const cur = targetVideo.currentTime
          if (Math.abs(cur - targetTime) > 0.05) {
            targetVideo.currentTime = Math.max(0, Math.min(targetVideo.duration || Infinity, targetTime))
          }
        }
      }
    })
  }, [syncMap, reviewSegs, activeCam])

  const syncLiveVideos = useCallback((activeTime) => {
    if (!liveSyncMap) return
    const aHls = hlsRefs[activeCam].current
    if (!aHls) return
    const details = aHls.levels?.[aHls.currentLevel]?.details
    if (!details || details.fragments.length === 0) return

    let aFrag = details.fragments.find(f => f.start <= activeTime && f.start + f.duration >= activeTime)
    if (!aFrag) {
      aFrag = details.fragments.reduce((prev, curr) => {
        const pDist = Math.abs((prev.start + prev.duration / 2) - activeTime)
        const cDist = Math.abs((curr.start + curr.duration / 2) - activeTime)
        return cDist < pDist ? curr : prev
      })
    }

    if (!aFrag) return
    const aUrl = aFrag.relurl || aFrag.url || ''
    const aMatch = aUrl.match(/seg_(\d+)\.ts/)
    const sn = aMatch ? parseInt(aMatch[1], 10) : aFrag.sn
    const offsetInSeg = Math.max(0, activeTime - aFrag.start)

    CAMERAS.forEach(targetCam => {
      if (targetCam === activeCam) return
      const targetVideo = videoRefs[targetCam].current
      const mapping = liveSyncMap[sn]?.[targetCam]
      if (mapping && targetVideo) {
        let baseStart = null
        const tHls = hlsRefs[targetCam].current
        if (tHls && tHls.levels?.[tHls.currentLevel]?.details?.fragments) {
          const frags = tHls.levels[tHls.currentLevel].details.fragments
          const tFrag = frags.find(f => {
            const m = (f.relurl || f.url || '').match(/seg_(\d+)\.ts/)
            return (m ? parseInt(m[1], 10) : f.sn) === mapping.segment
          })
          if (tFrag) {
            baseStart = tFrag.start
          }
        }

        if (baseStart !== null) {
          const targetTime = baseStart + mapping.offset + offsetInSeg
          if (Math.abs(targetVideo.currentTime - targetTime) > 0.15) {
            targetVideo.currentTime = targetTime
          }
        }
      }
    })
  }, [activeCam, liveSyncMap])

  const tick = useCallback(() => {
    const video = videoRefs[activeCam].current
    const hls = hlsRefs[activeCam].current
    if (video) {
      const now = performance.now()
      const dt = (now - lastTickRef.current) / 1000
      lastTickRef.current = now

      let globalTime = video.currentTime;
      if (modeRef.current === 'review') {
        const segs = reviewSegs[activeCam];
        if (segs && segs.length > 0) {
          let seg = segs.find(s => video.currentTime >= s.localStart && video.currentTime <= s.localEnd);
          if (!seg) seg = segs.reduce((p, c) => Math.abs(video.currentTime - p.localStart) < Math.abs(video.currentTime - c.localStart) ? p : c);
          globalTime = seg.start + (video.currentTime - seg.localStart);
        }
      }
      setCurrentTime(globalTime)
      if (modeRef.current === 'live') {
        let edge = liveEdgeRef.current;
        if (edge === undefined || edge === null) {
          edge = hls?.liveSyncPosition || 0;
        }
        edge += dt; // Smoothly advance the live edge without relying on HLS.js when paused

        // Hls.js liveSyncPosition inherently jumps by 6 seconds every time a new chunk is appended.
        // To prevent the UI red line from jumping or sprinting (which visually breaks the playhead position),
        // we only snap if it has drifted catastrophically (> 10s). Otherwise, we let dt glide it perfectly smoothly.
        if (hls?.liveSyncPosition && !video.paused && !video.seeking) {
          if (Math.abs(edge - hls.liveSyncPosition) > 10.0) {
            edge = hls.liveSyncPosition;
          }
        }

        setLiveEdge(edge);
        liveEdgeRef.current = edge;
      }
      if (video.buffered.length > 0) {
        setBufferStart(video.buffered.start(0))
        setBufferedEnd(video.buffered.end(video.buffered.length - 1))
      }
      if (!video.seeking && !ignoreSyncRef.current) {
        if (modeRef.current === 'review') {
          // Disabled background scrubbing to prevent MediaSource crashes on paused elements
          // syncReviewVideos(video.currentTime)
        } else if (modeRef.current === 'live') {
          const livePos = hls?.liveSyncPosition
          const isCurrentlyLive = livePos !== null && livePos !== undefined && video.currentTime >= livePos - 3.0
          if (!isCurrentlyLive) {
            // Disabled background scrubbing to prevent MediaSource crashes on paused elements
            // syncLiveVideos(video.currentTime)
          }
        }
      }
    }

    // Check for GAP segments to show "NO FRAMES" precisely aligned with playhead
    let updatedGap = false;
    const newGap = { ...gapState }
    CAMERAS.forEach(cam => {
      const v = videoRefs[cam].current
      const h = hlsRefs[cam].current
      if (v && h && v.readyState >= 2) { // Ensure there is enough data
        const ct = v.currentTime
        const details = h.levels?.[h.currentLevel]?.details
        if (details) {
          const frag = details.fragments.find(f => f.start <= ct && f.start + f.duration >= ct + 0.1) ||
            details.fragments.find(f => Math.abs(f.start - ct) < 1.0)

          if (frag) {
            const url = frag.relurl || frag.url || ''
            const isGap = url.includes(`gap_${cam}.ts`)
            if (newGap[cam] !== isGap) {
              newGap[cam] = isGap
              updatedGap = true
            }
          }
        }
      }
    })

    if (updatedGap) {
      setGapState(newGap)
    }

    rafRef.current = requestAnimationFrame(tick)
  }, [activeCam, syncReviewVideos, syncLiveVideos, gapState])

  const initLive = useCallback(() => {
    setIsPlaying(true)
    CAMERAS.forEach(cam => {
      const video = videoRefs[cam].current
      if (!video) return

      const liveConfig = { ...LIVE_CONFIG }
      if (cam !== activeCamRef.current) {
        liveConfig.liveMaxLatencyDurationCount = 9999
      }
      const hls = new Hls(liveConfig)
      hlsRefs[cam].current = hls
      hls.loadSource(CAM_STREAM_URLS[cam])
      hls.attachMedia(video)

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setStatus('playing')
        if (cam === activeCamRef.current) {
          video.play().catch(() => { })
        }
      })

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log(`[HLS] Fatal network error for ${cam}, trying to recover...`);
              if (data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR) {
                const livePos = hls.liveSyncPosition;
                if (livePos != null) {
                  console.log(`[HLS] Fragment permanently missing, jumping to live edge to escape 404 loop!`);
                  if (cam === activeCamRef.current) {
                    hls.config.liveMaxLatencyDurationCount = LIVE_CONFIG.liveMaxLatencyDurationCount;
                  }
                  video.currentTime = livePos;
                }
              }
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log(`[HLS] Fatal media error for ${cam}, trying to recover...`);
              hls._mediaErrorCount = (hls._mediaErrorCount || 0) + 1;
              if (hls._mediaErrorCount <= 1) {
                hls.recoverMediaError();
              } else if (hls._mediaErrorCount === 2) {
                hls.swapAudioCodec();
                hls.recoverMediaError();
              } else {
                console.warn(`[HLS] Repeated media errors, nudging playhead forward to escape loop!`);
                video.currentTime += 0.5;
                hls._mediaErrorCount = 0;
              }
              break;
            default:
              console.error(`[HLS] Unrecoverable error for ${cam}:`, data);
              hls.destroy();
              break;
          }
        } else if (data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR) {
          console.warn(`[HLS] Fragment load failed for ${cam} (likely 404 from slow Pi). HLS.js will retry.`);
        }
      })

      hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
        if (!data.payload || !data.payload.byteLength) return
        const url = data.frag.relurl || data.frag.url || ''
        const match = url.match(/seg_(\d+)\.ts/)
        const absSegIdx = match ? parseInt(match[1], 10) : data.frag.sn

        if (!segmentStartTimesRef.current[cam]) {
          segmentStartTimesRef.current[cam] = {}
        }

        const existing = rollingBuffers[cam].current
        const existingSeg = existing.find(s => s.absSegIdx === absSegIdx)

        if (existingSeg) {
          const delta = data.frag.start - existingSeg.originalStart
          // Ignore massive deltas (e.g. from HLS.js seeking far back and hitting a discontinuity)
          if (Math.abs(delta) > 0.1 && Math.abs(delta) < 5.0) {
            console.log('SHIFTING TIMELINE DELTA:', delta);
            rollingBuffers[cam].current = existing.map(s => ({
              ...s,
              originalStart: s.originalStart + delta
            }))
            for (const key in segmentStartTimesRef.current[cam]) {
              segmentStartTimesRef.current[cam][key] += delta
            }
            if (cam === activeCamRef.current && modeRef.current === 'live') {
              const updated = rollingBuffers[cam].current
              setLiveSegments(updated.map(s => ({
                sn: s.sn,
                absSegIdx: s.absSegIdx,
                start: s.originalStart,
                end: s.originalStart + s.duration
              })))
            }
          }
        } else {
          // console.log(`[HLS NATIVE] Intercepted segment ${cam}/${absSegIdx} natively from video player!`)
          segmentStartTimesRef.current[cam][absSegIdx] = data.frag.start
          const entry = {
            sn: data.frag.sn,
            absSegIdx: absSegIdx,
            originalStart: data.frag.start,
            duration: data.frag.duration,
            bytes: data.payload.slice(0)
          }
          const updated = [...rollingBuffers[cam].current, entry]
            .sort((a, b) => a.absSegIdx - b.absSegIdx)
            .slice(-REVIEW_BUFFER_SIZE)
          rollingBuffers[cam].current = updated

          if (cam === activeCamRef.current) {
            setLiveSegments(updated.map(s => ({
              sn: s.sn,
              absSegIdx: s.absSegIdx,
              start: s.originalStart,
              end: s.originalStart + s.duration
            })))
            fetch(`${backendUrl}/sync_map?from_camera=${cam}&sns=${absSegIdx}`)
              .then(res => res.json())
              .then(syncData => {
                setLiveSyncMap(prev => ({ ...prev, ...syncData }))
              })
              .catch(e => console.warn('Failed to fetch live sync segment map', e))
          }
        }
      })
    })
    modeRef.current = 'live'
    setMode('live')
  }, [])

  const enterReview = useCallback(() => {
    console.log('[MODE] Entering Review Mode')
    if (rollingBuffers[activeCam].current.length === 0) return false

    const newReviewSegs = { source: [], sink: [], hq: [] }

    CAMERAS.forEach(cam => {
      let snapshot = rollingBuffers[cam].current.slice()

      const fragUrls = snapshot.map(s => URL.createObjectURL(new Blob([s.bytes], { type: 'video/mp2t' })))
      const m3u8 = buildReviewPlaylist(snapshot, fragUrls)
      const m3u8Url = URL.createObjectURL(new Blob([m3u8], { type: 'application/vnd.apple.mpegurl' }))
      blobUrlsRef.current.push(...fragUrls, m3u8Url)

      hlsRefs[cam].current?.destroy()

      const hls = new Hls(REVIEW_CONFIG)
      hlsRefs[cam].current = hls
      hls.loadSource(m3u8Url)
      hls.attachMedia(videoRefs[cam].current)

      hls.once(Hls.Events.MANIFEST_PARSED, () => {
        videoRefs[cam].current.currentTime = 0
        videoRefs[cam].current.pause()
      })

      let t = 0
      newReviewSegs[cam] = snapshot.map(s => {
        const seg = {
          sn: s.sn,
          absSegIdx: s.absSegIdx,
          start: t, // Local time IS global time in Review mode, making it mathematically gapless
          end: t + s.duration,
          localStart: t,
          localEnd: t + s.duration,
          duration: s.duration,
          originalStart: s.originalStart
        }
        t += s.duration
        return seg
      })
    })

    setReviewSegs(newReviewSegs)
    setIsPlaying(false)

    // Fetch full 3-way sync map for all cameras in the snapshot
    Promise.all(CAMERAS.map(c => {
      const sns = rollingBuffers[c].current.map(s => s.absSegIdx).join(',')
      if (!sns) return Promise.resolve({ cam: c, data: {} })
      return fetch(`${backendUrl}/sync_map?from_camera=${c}&sns=${sns}`)
        .then(res => res.json())
        .then(data => ({ cam: c, data }))
    })).then(results => {
      const fullMap = {}
      results.forEach(r => { fullMap[r.cam] = r.data })
      setSyncMap(fullMap)
    }).catch(e => console.error('Failed to fetch full sync map', e))

    setLiveEdge(null)
    setBufferStart(null)
    setBufferedEnd(null)
    modeRef.current = 'review'
    setMode('review')
    return true
  }, [activeCam, liveEdge, liveSegments, liveSyncMap])

  const exitReview = useCallback(() => {
    console.log('[MODE] Exiting Review Mode (returning to Live)')
    CAMERAS.forEach(cam => {
      hlsRefs[cam].current?.destroy()
      hlsRefs[cam].current = null
    })
    blobUrlsRef.current.forEach(URL.revokeObjectURL)
    blobUrlsRef.current = []

    // Clear Review UI timeline but keep Live DVR history intact!
    setReviewSegs({ source: [], sink: [], hq: [] })
    setSyncMap(null)
    setPlaybackRate(1.0)
    modeRef.current = 'live'
    setMode('live')

    // Force active camera to live edge when rebuilding live instances
    setLiveEdge(null)
    initLive()
  }, [initLive, activeCam])

  useEffect(() => {
    initLive()
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(rafRef.current)
      CAMERAS.forEach(c => hlsRefs[c].current?.destroy())
      blobUrlsRef.current.forEach(URL.revokeObjectURL)
    }
  }, []) // run once on mount

  useEffect(() => {
    let active = true;

    const pollPlaylists = async () => {
      for (const cam of CAMERAS) {
        try {
          const playlistUrl = CAM_STREAM_URLS[cam];
          const res = await fetch(playlistUrl);
          if (!res.ok) continue;
          const text = await res.text();

          // Parse playlist
          const lines = text.split('\n');
          let mediaSequence = 0;
          const playlistSegs = [];

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
              mediaSequence = parseInt(line.split(':')[1], 10);
            } else if (line.startsWith('#EXTINF:')) {
              const duration = parseFloat(line.split(':')[1].split(',')[0]);
              let name = lines[i + 1]?.trim();
              let offset = 1;

              // Skip the #EXT-X-GAP tag if it's there
              if (name === '#EXT-X-GAP') {
                name = lines[i + 2]?.trim();
                offset = 2;
              }

              if (name && name !== 'gap.ts') {
                const match = name.match(/seg_(\d+)\.ts/)
                const absSegIdx = match ? parseInt(match[1], 10) : (mediaSequence + playlistSegs.length);
                playlistSegs.push({ duration, name, absSegIdx });
              }
              i += offset;
            }
          }

          if (!active) return;

          // Compute start times for all segments in this playlist
          for (let i = 0; i < playlistSegs.length; i++) {
            const seg = playlistSegs[i];
            if (segmentStartTimesRef.current[cam][seg.absSegIdx] !== undefined) {
              continue;
            }

            // Try to compute from previous segment in playlist
            if (i > 0) {
              const prevSeg = playlistSegs[i - 1];
              const prevStart = segmentStartTimesRef.current[cam][prevSeg.absSegIdx];
              if (prevStart !== undefined) {
                segmentStartTimesRef.current[cam][seg.absSegIdx] = prevStart + prevSeg.duration;
                continue;
              }
            }

            // Try to find closest defined segment in the map
            const keys = Object.keys(segmentStartTimesRef.current[cam]).map(Number).sort((a, b) => a - b);
            if (keys.length > 0) {
              const closest = keys.reduce((prev, curr) => Math.abs(curr - seg.absSegIdx) < Math.abs(prev - seg.absSegIdx) ? curr : prev);
              const closestStart = segmentStartTimesRef.current[cam][closest];
              segmentStartTimesRef.current[cam][seg.absSegIdx] = closestStart + (seg.absSegIdx - closest) * 6.0;
            } else {
              segmentStartTimesRef.current[cam][seg.absSegIdx] = seg.absSegIdx * 6.0;
            }
          }

          // Now check which segments are missing from rollingBuffers
          const currentBuffer = rollingBuffers[cam].current;
          const existingAbsSegs = new Set(currentBuffer.map(s => s.absSegIdx));

          for (const seg of playlistSegs) {
            // Ignore historical segments that were thrown away by a hard reset
            if (seg.absSegIdx < cutoffAbsSegIdxRef.current[cam]) continue;

            if (existingAbsSegs.has(seg.absSegIdx)) continue;
            if (downloadingSegmentsRef.current[cam].has(seg.absSegIdx)) continue;

            // Skip manual fetch for the active camera ONLY IF the video is actively playing
            // and the segment is recent enough that Hls.js is likely about to fetch it natively.
            if (cam === activeCamRef.current && modeRef.current === 'live') {
              const video = videoRefs[cam].current;
              if (video && !video.paused) {
                const latestAbsSegIdx = playlistSegs[playlistSegs.length - 1].absSegIdx;
                const isRecent = (latestAbsSegIdx - seg.absSegIdx) <= 4;
                if (isRecent) {
                  // console.log(`[DVR Fetcher] SKIPPING manual fetch for ${cam}/${seg.absSegIdx} (delegating to Hls.js native fetch)`);
                  continue;
                }
              }
            }

            // console.log(`[DVR Fetcher] Manually fetching BACKGROUND segment ${cam}/${seg.absSegIdx}`);

            // Start downloading!
            downloadingSegmentsRef.current[cam].add(seg.absSegIdx);

            // Construct absolute URL for segment
            const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/'));
            const segUrl = seg.name.startsWith('http') ? seg.name : `${baseUrl}/${seg.name}`;

            fetch(segUrl)
              .then(async (segRes) => {
                if (!segRes.ok) throw new Error(`HTTP ${segRes.status}`);
                const arrayBuffer = await segRes.arrayBuffer();

                if (!active) return;

                const entry = {
                  sn: seg.absSegIdx,
                  absSegIdx: seg.absSegIdx,
                  originalStart: segmentStartTimesRef.current[cam][seg.absSegIdx],
                  duration: seg.duration,
                  bytes: arrayBuffer
                };

                // Merge, sort, and slice to REVIEW_BUFFER_SIZE
                const updated = [...rollingBuffers[cam].current, entry]
                  .filter((v, idx, self) => self.findIndex(t => t.absSegIdx === v.absSegIdx) === idx)
                  .sort((a, b) => a.absSegIdx - b.absSegIdx)
                  .slice(-REVIEW_BUFFER_SIZE);

                rollingBuffers[cam].current = updated;

                if (cam === activeCamRef.current && modeRef.current === 'live') {
                  setLiveSegments(updated.map(s => ({
                    sn: s.sn,
                    absSegIdx: s.absSegIdx,
                    start: s.originalStart,
                    end: s.originalStart + s.duration
                  })));

                  // Fetch live sync map for this new segment
                  fetch(`${backendUrl}/sync_map?from_camera=${cam}&sns=${seg.absSegIdx}`)
                    .then(r => r.json())
                    .then(syncData => {
                      if (active && modeRef.current === 'live') {
                        setLiveSyncMap(prev => ({ ...prev, ...syncData }));
                      }
                    })
                    .catch(e => console.warn('Failed to fetch sync map for downloaded segment', e));
                }
              })
              .catch((err) => {
                console.warn(`Error downloading segment ${seg.name} in background:`, err);
              })
              .finally(() => {
                downloadingSegmentsRef.current[cam].delete(seg.absSegIdx);
              });
          }
        } catch (e) {
          console.warn(`Error polling playlist for ${cam} in background:`, e);
        }
      }
    };

    pollPlaylists();
    const intervalId = setInterval(pollPlaylists, 1000);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [activeCam, setLiveSegments, setLiveSyncMap]);

  const getAllCamPositions = useCallback(() => {
    const pos = {}
    CAMERAS.forEach(cam => {
      const hls = hlsRefs[cam].current
      const video = videoRefs[cam].current
      if (!hls || !video) return
      const details = hls.levels?.[hls.currentLevel]?.details
      if (!details || details.fragments.length === 0) return
      const ct = video.currentTime
      let frag = details.fragments.find(f => f.start <= ct && f.start + f.duration > ct)
      if (!frag) frag = details.fragments.reduce((p, c) =>
        Math.abs(c.start + c.duration / 2 - ct) < Math.abs(p.start + p.duration / 2 - ct) ? c : p
      )
      if (!frag) return
      const url = frag.relurl || frag.url || ''
      const m = url.match(/seg_(\d+)\.ts/)
      const seg = m ? parseInt(m[1], 10) : frag.sn
      pos[cam] = { seg, offset: parseFloat(Math.max(0, ct - frag.start).toFixed(3)) }
    })
    return pos
  }, [])

  const doLiveSync = useCallback(async () => {
    if (modeRef.current !== 'live') return
    const masterCam = activeCamRef.current
    const hls = hlsRefs[masterCam].current
    const video = videoRefs[masterCam].current
    if (!hls || !video) return
    const details = hls.levels?.[hls.currentLevel]?.details
    if (!details?.fragments?.length) return
    const ct = video.currentTime
    let frag = details.fragments.find(f => f.start <= ct && f.start + f.duration > ct)
      || details.fragments[details.fragments.length - 1]
    if (!frag) return
    const url = frag.relurl || frag.url || ''
    const m = url.match(/seg_(\d+)\.ts/)
    const absSegIdx = m ? parseInt(m[1], 10) : frag.sn
    const offset = Math.max(0, ct - frag.start)
    try {
      const res = await fetch(`${backendUrl}/sync?from_camera=${masterCam}&from_seg=${absSegIdx}&from_offset=${offset}`)
      if (!res.ok) return
      const data = await res.json()

      const targetCams = CAMERAS.filter(c => c !== masterCam)
      for (const targetCam of targetCams) {
        const targetSync = data[targetCam]
        if (!targetSync) continue
        const tHls = hlsRefs[targetCam].current
        const tVideo = videoRefs[targetCam].current
        if (!tHls || !tVideo) continue
        const tDetails = tHls.levels?.[tHls.currentLevel]?.details
        if (!tDetails) continue
        const tFrag = tDetails.fragments.find(f => {
          const fu = f.relurl || f.url || ''
          const fm = fu.match(/seg_(\d+)\.ts/)
          return (fm ? parseInt(fm[1], 10) : f.sn) === targetSync.segment
        })
        if (tFrag) {
          const newTime = tFrag.start + targetSync.offset
          if (Math.abs(tVideo.currentTime - newTime) > 0.5)
            tVideo.currentTime = newTime
        }
      }
    } catch (e) { console.warn('doLiveSync failed', e) }
  }, [])

  // Auto-pause when entering Review mode, and apply playback rate
  useEffect(() => {
    CAMERAS.forEach(cam => {
      if (videoRefs[cam].current) {
        videoRefs[cam].current.playbackRate = playbackRate
      }
    })
  }, [playbackRate])

  // Initial sync 2s after mount (lets manifests parse), then every 4s
  useEffect(() => {
    let intervalId
    const t0 = setTimeout(() => {
      doLiveSync()
      intervalId = setInterval(doLiveSync, 4000)
    }, 2000)
    return () => { clearTimeout(t0); clearInterval(intervalId) }
  }, [doLiveSync])

  // Continuously poll check_sync every ~6667ms (200 frames at 30fps)
  useEffect(() => {
    const poll = async () => {
      try {
        const pos = getAllCamPositions()
        if (modeRef.current === 'review') return // Do not poll sync in review mode
        if (!pos.source || !pos.sink || !pos.hq) return
        const p = new URLSearchParams({
          source_seg: pos.source.seg, source_off: pos.source.offset,
          sink_seg: pos.sink.seg, sink_off: pos.sink.offset,
          hq_seg: pos.hq.seg, hq_off: pos.hq.offset,
          tolerance: 15,
        })
        const res = await fetch(`${backendUrl}/check_sync?${p}`)
        if (!res.ok) return
        const v = await res.json()
        if (v?.checks) {
          console.log(
            `[SYNC LOG] segs: SRC=${pos.source.seg} SNK=${pos.sink.seg} HQ=${pos.hq.seg} | ` +
            `frames: SRC=${v.frames.source} SNK=${v.frames.sink} HQ=${v.frames.hq}`
          )
        }
      } catch (_) { }
    }
    const id = setInterval(poll, 3333)
    return () => clearInterval(id)
  }, [getAllCamPositions])

  const handleSwitchCam = async (targetCam) => {
    if (targetCam === activeCam) return
    const currentVideo = videoRefs[activeCam].current
    const targetVideo = videoRefs[targetCam].current
    if (!currentVideo || !targetVideo) return

    ignoreSyncRef.current = true

    // Sync API Logic
    let isLive = false;

    if (mode === 'live') {
      const hls = hlsRefs[activeCam].current
      const activeLivePos = hls?.liveSyncPosition
      isLive = activeLivePos != null && currentVideo.currentTime >= activeLivePos - 2.0

      const details = hls?.levels?.[hls.currentLevel]?.details
      if (details) {
        const ct = currentVideo.currentTime
        let frag = details.fragments.find(f => f.start <= ct && f.start + f.duration >= ct)
        if (!frag && details.fragments.length > 0) {
          frag = details.fragments.reduce((prev, curr) => {
            const prevDist = Math.abs((prev.start + prev.duration / 2) - ct)
            const currDist = Math.abs((curr.start + curr.duration / 2) - ct)
            return currDist < prevDist ? curr : prev
          })
        }
        if (frag) {
          const offset = ct - frag.start
          const url = frag.relurl || frag.url || ''
          const match = url.match(/seg_(\d+)\.ts/)
          const absSegIdx = match ? parseInt(match[1], 10) : frag.sn
          try {
            const res = await fetch(`${backendUrl}/sync?from_camera=${activeCam}&from_seg=${absSegIdx}&from_offset=${offset}`)
            if (res.ok) {
              const data = await res.json()
              const targetSync = data[targetCam]
              const targetHls = hlsRefs[targetCam].current
              const tDetails = targetHls?.levels?.[targetHls.currentLevel]?.details
              let baseStart = null

              if (tDetails) {
                const tFrag = tDetails.fragments.find(f => {
                  const fUrl = f.relurl || f.url || ''
                  const fMatch = fUrl.match(/seg_(\d+)\.ts/)
                  const fAbs = fMatch ? parseInt(fMatch[1], 10) : f.sn
                  return fAbs === targetSync.segment
                })
                if (tFrag) {
                  baseStart = tFrag.start
                }
              }

              if (baseStart === null && segmentStartTimesRef.current[targetCam]?.[targetSync.segment] !== undefined) {
                baseStart = segmentStartTimesRef.current[targetCam][targetSync.segment]
              }

              if (baseStart !== null) {
                const newTime = baseStart + targetSync.offset

                // If active video is at the live edge, allow jumping directly to target's live edge to avoid stale math
                if (isLive && targetHls?.liveSyncPosition != null && Math.abs(targetHls.liveSyncPosition - newTime) < 3.0) {
                  targetVideo.currentTime = targetHls.liveSyncPosition
                } else if (Math.abs(targetVideo.currentTime - newTime) > 0.15) {
                  targetVideo.currentTime = newTime
                }
              }

              // Verify sync: read all cameras' actual positions and check against CSV
              setTimeout(async () => {
                try {
                  const pos = getAllCamPositions()
                  if (!pos.source || !pos.sink || !pos.hq) return
                  const p = new URLSearchParams({
                    source_seg: pos.source.seg, source_off: pos.source.offset,
                    sink_seg: pos.sink.seg, sink_off: pos.sink.offset,
                    hq_seg: pos.hq.seg, hq_off: pos.hq.offset,
                    tolerance: 15,
                  })
                  const vRes = await fetch(`${backendUrl}/check_sync?${p}`)
                  const v = await vRes.json()
                  if (v?.checks) {
                    console.log(
                      `[SYNC SWITCH] ${activeCam} → ${targetCam} | frames: SRC=${v.frames.source} SNK=${v.frames.sink} HQ=${v.frames.hq}`
                    )
                  }
                } catch (e) { console.warn('check_sync failed', e) }
              }, 200)
            }
          } catch (e) { console.error('Sync failed', e) }
        }
      }
    } else {
      // In review mode, perfectly map the local time using the exact sub-second sync offset from the full syncMap!
      let currentLocal = currentVideo.currentTime;
      let offset = 0;
      const currentSegs = reviewSegs[activeCam];
      
      if (currentSegs && currentSegs.length > 0) {
        const seg = currentSegs.find(s => currentLocal >= s.localStart && currentLocal <= s.localEnd) || currentSegs[0];
        
        // Look up the precise offset in the fully-populated 3-way sync map
        const mapping = syncMap?.[activeCam]?.[seg.absSegIdx]?.[targetCam];
        if (mapping) {
          offset = mapping.offset;
        } else {
          console.warn(`[SYNC] Missing mapping from ${activeCam} to ${targetCam} at seg ${seg.absSegIdx}`);
        }
      }
      
      targetVideo.currentTime = Math.max(0, currentLocal + offset);
    }

    // update state
    currentVideo.pause()
    if (isPlaying) {
      if (modeRef.current === 'live') {
        const hlsTarget = hlsRefs[targetCam].current
        const hlsCurrent = hlsRefs[activeCam].current
        if (hlsTarget) {
          hlsTarget.config.liveMaxLatencyDurationCount = isLive ? LIVE_CONFIG.liveMaxLatencyDurationCount : 9999
        }
        if (hlsCurrent) {
          hlsCurrent.config.liveMaxLatencyDurationCount = 9999
        }
        // Instantly sync the background camera's time to the active camera so it doesn't play from the past!
        syncLiveVideos(currentVideo.currentTime)

        targetVideo.play().catch(e => console.log('play failed', e))
      }
    }
    setActiveCam(targetCam)
    setTimeout(() => {
      ignoreSyncRef.current = false
    }, 300)
  }

  const handleSeek = (time, forcePause = false) => {
    const video = videoRefs[activeCam].current
    if (video) {
      if (mode === 'review') {
        // Seek all cameras perfectly using the sub-second offset!
        CAMERAS.forEach(cam => {
          if (videoRefs[cam].current) {
            let offset = 0;
            if (cam !== activeCamRef.current) {
              const activeSegs = reviewSegs[activeCamRef.current];
              if (activeSegs && activeSegs.length > 0) {
                const seg = activeSegs.find(s => time >= s.localStart && time <= s.localEnd) || activeSegs[0];
                const mapping = syncMap?.[seg.absSegIdx]?.[cam];
                if (mapping) offset = mapping.offset;
              }
            }
            videoRefs[cam].current.currentTime = Math.max(0, time + offset);

            // If it was playing but hit the end and got stuck, resume playing!
            if (!forcePause && isPlaying) videoRefs[cam].current.play().catch(() => { });
          }
        })
        if (forcePause) setIsPlaying(false)
      } else {
        // In live mode: check if we're seeking to the live edge (GO LIVE button)
        const livePos = liveEdgeRef.current;
        const isLiveEdge = livePos != null && time >= livePos - 2.0
        if (isLiveEdge) {
          // GO LIVE: restore latency enforcement ONLY for active camera
          let safeSyncPos = null;
          CAMERAS.forEach(cam => {
            const hls = hlsRefs[cam].current
            const camVideo = videoRefs[cam].current
            if (!hls || !camVideo) return

            if (cam === activeCamRef.current) {
              hls.config.liveMaxLatencyDurationCount = LIVE_CONFIG.liveMaxLatencyDurationCount
              safeSyncPos = hls.liveSyncPosition != null ? hls.liveSyncPosition : (livePos != null ? livePos - 2.0 : null)
              if (safeSyncPos != null) camVideo.currentTime = safeSyncPos
              camVideo.play().catch(() => { })
            } else {
              hls.config.liveMaxLatencyDurationCount = 9999
              camVideo.play().catch(() => { })
            }
          })
          if (safeSyncPos != null) {
            syncLiveVideos(safeSyncPos)
          } else if (livePos != null) {
            syncLiveVideos(livePos)
          }
          if (forcePause) {
            setIsPlaying(false)
            CAMERAS.forEach(cam => {
              if (videoRefs[cam].current) videoRefs[cam].current.pause()
            })
          } else {
            setIsPlaying(true)
          }
        } else {
          // Seeking to a past segment: mimic pause to avoid HLS.js stream controller seek-recovery
          CAMERAS.forEach(cam => {
            if (hlsRefs[cam].current) {
              hlsRefs[cam].current.config.liveMaxLatencyDurationCount = 9999
            }
            if (videoRefs[cam].current) {
              videoRefs[cam].current.pause()
            }
          })

          video.currentTime = time
          syncLiveVideos(time)

          if (forcePause) {
            setIsPlaying(false)
          } else if (isPlaying) {
            CAMERAS.forEach(cam => {
              if (videoRefs[cam].current) {
                videoRefs[cam].current.play().catch(() => { })
              }
            })
          }
        }
      }
    }
  }


  const inReview = mode === 'review'
  const activeReviewSegs = inReview ? (reviewSegs[activeCam] || []) : []
  const displaySegments = inReview ? activeReviewSegs : liveSegments
  const displayLiveEdge = inReview ? (activeReviewSegs.length > 0 ? activeReviewSegs[activeReviewSegs.length - 1].end : null) : liveEdge
  // Force the left edge of the timeline to perfectly lock to the 30-segment window, ignoring HLS.js's "zombie" cache
  const displayBufferStart = inReview ? 0 : (liveSegments.length > 0 ? liveSegments[0].start : bufferStart)
  const displayBufferedEnd = inReview ? displayLiveEdge : bufferedEnd

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0a0a0a', color: '#fff' }}>
      <header style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #222' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span style={{ fontWeight: 'bold', letterSpacing: '2px', fontSize: '18px' }}>Judex AI</span>
          <CameraSelector active={activeCam} onSwitch={handleSwitchCam} />
        </div>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          <button
            onClick={inReview ? exitReview : enterReview}
            style={{
              padding: '10px 28px', borderRadius: '8px', border: 'none', cursor: 'pointer',
              background: inReview ? 'linear-gradient(135deg, #4a90e2, #2e6db4)' : 'linear-gradient(135deg, var(--amber, #f5a623), #d48812)',
              color: '#000', fontWeight: '800', fontSize: '14px', letterSpacing: '1px',
              boxShadow: inReview ? '0 4px 15px rgba(74, 144, 226, 0.4)' : '0 4px 15px rgba(245, 166, 35, 0.4)',
              transition: 'all 0.2s ease-in-out',
              textTransform: 'uppercase'
            }}
          >
            {inReview ? 'GO LIVE' : 'ENTER REVIEW'}
          </button>
        </div>
      </header>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {CAMERAS.map(cam => (
          <div
            key={cam}
            style={{
              position: 'absolute', inset: 0,
              opacity: cam === activeCam ? 1 : 0,
              pointerEvents: cam === activeCam ? 'auto' : 'none',
              transition: 'opacity 0.1s ease-in-out'
            }}
          >
            <video
              ref={videoRefs[cam]}
              muted={true}
              playsInline
              style={{
                width: '100%', height: '100%', objectFit: 'contain'
              }}
            />
            {/* NO FRAMES OVERLAY */}
            {gapState[cam] && (
              <div style={{
                position: 'absolute', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.95)',
                display: 'flex', justifyContent: 'center', alignItems: 'center',
                color: '#ff4444', fontSize: '32px', fontWeight: 'bold', letterSpacing: '4px', zIndex: 10
              }}>
                NO FRAMES AVAILABLE
              </div>
            )}
          </div>
        ))}

        {inReview && (
          <div style={{
            position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(255,0,0,0.8)', padding: '6px 16px', borderRadius: '20px',
            fontSize: '12px', fontWeight: 'bold', letterSpacing: '2px', pointerEvents: 'none'
          }}>REVIEW MODE ACTIVE</div>
        )}

        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '40px 32px 20px', background: 'linear-gradient(transparent, rgba(0,0,0,0.9))' }}>
          <SeekBar
            currentTime={currentTime}
            liveEdge={displayLiveEdge}
            bufferStart={displayBufferStart}
            bufferedEnd={displayBufferedEnd}
            segments={displaySegments}
            events={mappedEvents}
            onSeek={handleSeek}
            playbackRate={playbackRate}
            onPlaybackRateChange={setPlaybackRate}
            onEventSelect={setSelectedEvent}
            mode={mode}
            isPlaying={isPlaying}
            onTogglePlay={handleTogglePlay}
          />
        </div>

        </div>

        <div style={{ 
          height: selectedEvent ? '50%' : '0px', 
          transition: 'height 0.4s cubic-bezier(0.4, 0, 0.2, 1)', 
          overflow: 'hidden',
          background: '#0a0a0a',
          borderTop: selectedEvent ? '1px solid #222' : 'none',
          display: 'flex',
          flexDirection: 'column'
        }}>
          <EventPanel 
            event={selectedEvent} 
            events={mappedEvents}
            activeCam={activeCam} 
            onNavigate={(ev) => {
              setSelectedEvent(ev)
              handleSeek(ev.time, true)
            }}
            onClose={() => setSelectedEvent(null)} 
          />
        </div>
      </div>
    </div>
  )
}
