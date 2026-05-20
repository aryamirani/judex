import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import Hls from 'hls.js'
import SeekBar from './components/SeekBar.jsx'
import LiveBadge from './components/LiveBadge.jsx'
import CameraSelector from './components/CameraSelector.jsx'
import EventPanel from './components/EventPanel.jsx'

const REVIEW_BUFFER_SIZE = 30
const LIVE_THRESHOLD = 2

const LIVE_CONFIG = { backBufferLength: 60, maxBufferLength: 60, liveSyncDurationCount: 3, enableWorker: true }
const REVIEW_CONFIG = { enableWorker: true, maxBufferLength: 60, backBufferLength: 60 }

const CAMERAS = ['source', 'sink', 'hq']

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

  const rafRef = useRef(null)
  const modeRef = useRef('live')

  const [activeCam, setActiveCam] = useState('hq')
  const [mode, setMode] = useState('live')
  const [status, setStatus] = useState('connecting')
  const [events, setEvents] = useState([])
  
  // UI State for Active Camera
  const [currentTime, setCurrentTime] = useState(0)
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
            video.play().catch(e => console.log('play failed', e))
          } else {
            video.pause()
          }
        }
      })
      return nextPlaying
    })
  }, [])

  const activeCamRef = useRef(activeCam)
  const ignoreSyncRef = useRef(false)
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
      const absSns = buf.map(s => s.absSegIdx).filter(x => x !== undefined).join(',')
      if (absSns) {
        fetch(`http://localhost:8000/sync_map?from_camera=${activeCam}&sns=${absSns}`)
          .then(res => res.json())
          .then(data => setLiveSyncMap(data))
          .catch(e => console.warn('Failed to fetch live sync map on camera switch', e))
      }
    }
  }, [activeCam, mode])

  const isLive = mode === 'live' && liveEdge !== null && currentTime >= liveEdge - LIVE_THRESHOLD

  const fetchEvents = async () => {
    try {
      const res = await fetch('http://localhost:8000/events')
      const data = await res.json()
      setEvents(data)
    } catch (e) { console.warn('Failed to fetch events', e) }
  }

  useEffect(() => { fetchEvents() }, [])

  const mappedEvents = useMemo(() => {
    const currentSegs = mode === 'live' ? liveSegments : reviewSegs[activeCam]
    if (!currentSegs || currentSegs.length === 0) {
      return events.map(ev => ({
        ...ev,
        time: (ev.segments?.[activeCam] ?? 0) * 6.0 + (ev.offsets?.[activeCam] ?? 0)
      }))
    }
    const anchor = currentSegs[0]
    return events.map(ev => {
      const segNum = ev.segments?.[activeCam] ?? 0
      const offset = ev.offsets?.[activeCam] ?? 0
      
      const matchingSeg = currentSegs.find(s => s.absSegIdx === segNum)
      let playbackTime
      if (matchingSeg) {
        playbackTime = matchingSeg.start + offset
      } else {
        playbackTime = anchor.start + (segNum - (anchor.absSegIdx ?? anchor.sn)) * 6.0 + offset
      }
      return {
        ...ev,
        time: playbackTime
      }
    })
  }, [events, activeCam, mode, liveSegments, reviewSegs])

  const syncReviewVideos = useCallback((activeTime) => {
    if (!syncMap) return
    const activeList = reviewSegs[activeCam]
    if (!activeList || activeList.length === 0) return
    
    const activeSeg = activeList.find(s => activeTime >= s.start && activeTime <= s.end)
    if (!activeSeg) return
    
    const offsetInSeg = activeTime - activeSeg.start
    const sn = activeSeg.absSegIdx
    
    CAMERAS.forEach(cam => {
      if (cam === activeCam) return
      const mapping = syncMap[sn]?.[cam]
      if (!mapping) return
      
      const targetList = reviewSegs[cam]
      if (!targetList) return
      const targetSeg = targetList.find(s => s.absSegIdx === mapping.segment)
      if (targetSeg) {
        const targetTime = targetSeg.start + mapping.offset + offsetInSeg
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
    const activeList = liveSegments
    if (!activeList || activeList.length === 0) return
    
    const activeSeg = activeList.find(s => activeTime >= s.start && activeTime <= s.end)
    if (!activeSeg) return
    
    const offsetInSeg = activeTime - activeSeg.start
    const sn = activeSeg.absSegIdx
    
    CAMERAS.forEach(cam => {
      if (cam === activeCam) return
      const mapping = liveSyncMap[sn]?.[cam]
      if (!mapping) return
      
      const targetHls = hlsRefs[cam].current
      const tDetails = targetHls?.levels?.[targetHls.currentLevel]?.details
      const targetVideo = videoRefs[cam].current
      if (tDetails && targetVideo) {
        const targetSeg = tDetails.fragments.find(f => {
          const fUrl = f.relurl || f.url || ''
          const fMatch = fUrl.match(/seg_(\d+)\.ts/)
          const fAbs = fMatch ? parseInt(fMatch[1], 10) : f.sn
          return fAbs === mapping.segment
        })
        if (targetSeg) {
          const targetTime = targetSeg.start + mapping.offset + offsetInSeg
          const cur = targetVideo.currentTime
          if (Math.abs(cur - targetTime) > 0.15) {
            targetVideo.currentTime = targetTime
          }
        }
      }
    })
  }, [activeCam, liveSegments, liveSyncMap])

  const tick = useCallback(() => {
    const video = videoRefs[activeCam].current
    const hls = hlsRefs[activeCam].current
    if (video) {
      setCurrentTime(video.currentTime)
      if (modeRef.current === 'live' && hls?.liveSyncPosition) {
        setLiveEdge(hls.liveSyncPosition)
      }
      if (video.buffered.length > 0) {
        setBufferStart(video.buffered.start(0))
        setBufferedEnd(video.buffered.end(video.buffered.length - 1))
      }
      if (!video.seeking && !ignoreSyncRef.current) {
        if (modeRef.current === 'review') {
          syncReviewVideos(video.currentTime)
        } else if (modeRef.current === 'live') {
          const livePos = hls?.liveSyncPosition
          const isCurrentlyLive = livePos !== null && livePos !== undefined && video.currentTime >= livePos - 1.5
          if (!isCurrentlyLive) {
            syncLiveVideos(video.currentTime)
          }
        }
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [activeCam, syncReviewVideos, syncLiveVideos])

  const initLive = useCallback(() => {
    setIsPlaying(true)
    CAMERAS.forEach(cam => {
      const video = videoRefs[cam].current
      if (!video) return

      const hls = new Hls(LIVE_CONFIG)
      hlsRefs[cam].current = hls
      hls.loadSource(`http://localhost:8000/stream/${cam}/live.m3u8`)
      hls.attachMedia(video)

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setStatus('playing')
        video.play().catch(() => {})
      })

      hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
        if (!data.payload || !data.payload.byteLength) return
        const url = data.frag.relurl || data.frag.url || ''
        const match = url.match(/seg_(\d+)\.ts/)
        const absSegIdx = match ? parseInt(match[1], 10) : data.frag.sn
        const entry = {
          sn: data.frag.sn,
          absSegIdx: absSegIdx,
          originalStart: data.frag.start,
          duration: data.frag.duration,
          bytes: data.payload.slice(0)
        }
        rollingBuffers[cam].current = [...rollingBuffers[cam].current, entry].slice(-REVIEW_BUFFER_SIZE)
        
        if (cam === activeCamRef.current) {
          setLiveSegments(rollingBuffers[cam].current.map(s => ({
            sn: s.sn,
            absSegIdx: s.absSegIdx,
            start: s.originalStart,
            end: s.originalStart + s.duration
          })))
          fetch(`http://localhost:8000/sync_map?from_camera=${cam}&sns=${absSegIdx}`)
            .then(res => res.json())
            .then(data => {
              setLiveSyncMap(prev => ({ ...prev, ...data }))
            })
            .catch(e => console.warn('Failed to fetch live sync segment map', e))
        }
      })
    })
    modeRef.current = 'live'
    setMode('live')
  }, [])

  const enterReview = useCallback(() => {
    if (rollingBuffers[activeCam].current.length === 0) return false

    const newReviewSegs = { source: [], sink: [], hq: [] }

    CAMERAS.forEach(cam => {
      const snapshot = rollingBuffers[cam].current.slice()
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
          start: t,
          end: t + s.duration,
          duration: s.duration,
          originalStart: s.originalStart
        }
        t += s.duration
        return seg
      })
    })

    setReviewSegs(newReviewSegs)
    setIsPlaying(false)

    // Fetch sync map
    const activeSnapshot = rollingBuffers[activeCam].current
    const sns = activeSnapshot.map(s => s.absSegIdx).join(',')
    if (sns) {
      fetch(`http://localhost:8000/sync_map?from_camera=${activeCam}&sns=${sns}`)
        .then(res => res.json())
        .then(data => setSyncMap(data))
        .catch(e => console.error('Failed to fetch sync map', e))
    }
    
    setLiveEdge(null)
    setBufferStart(null)
    setBufferedEnd(null)
    modeRef.current = 'review'
    setMode('review')
    return true
  }, [activeCam])

  const exitReview = useCallback(() => {
    CAMERAS.forEach(cam => {
      hlsRefs[cam].current?.destroy()
      hlsRefs[cam].current = null
      rollingBuffers[cam].current = []
    })
    blobUrlsRef.current.forEach(URL.revokeObjectURL)
    blobUrlsRef.current = []
    
    setLiveSegments([])
    setReviewSegs({ source: [], sink: [], hq: [] })
    setSyncMap(null)
    initLive()
  }, [initLive])

  useEffect(() => {
    initLive()
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(rafRef.current)
      CAMERAS.forEach(c => hlsRefs[c].current?.destroy())
      blobUrlsRef.current.forEach(URL.revokeObjectURL)
    }
  }, []) // run once on mount

  const handleSwitchCam = async (targetCam) => {
    if (targetCam === activeCam) return
    const currentVideo = videoRefs[activeCam].current
    const targetVideo = videoRefs[targetCam].current
    if (!currentVideo || !targetVideo) return
    
    ignoreSyncRef.current = true
    
    // Sync API Logic
    if (mode === 'live') {
      const hls = hlsRefs[activeCam].current
      const details = hls?.levels?.[hls.currentLevel]?.details
      if (details) {
        const ct = currentVideo.currentTime
        let frag = details.fragments.find(f => f.start <= ct && f.start + f.duration >= ct)
        if (!frag && details.fragments.length > 0) {
          frag = details.fragments.reduce((prev, curr) => {
            const prevDist = Math.abs((prev.start + prev.duration/2) - ct)
            const currDist = Math.abs((curr.start + curr.duration/2) - ct)
            return currDist < prevDist ? curr : prev
          })
        }
        if (frag) {
          const offset = ct - frag.start
          const url = frag.relurl || frag.url || ''
          const match = url.match(/seg_(\d+)\.ts/)
          const absSegIdx = match ? parseInt(match[1], 10) : frag.sn
          try {
            const res = await fetch(`http://localhost:8000/sync?from_camera=${activeCam}&from_seg=${absSegIdx}&from_offset=${offset}`)
            if (res.ok) {
              const data = await res.json()
              const targetSync = data[targetCam]
              const targetHls = hlsRefs[targetCam].current
              const tDetails = targetHls?.levels?.[targetHls.currentLevel]?.details
              if (tDetails) {
                const tFrag = tDetails.fragments.find(f => {
                  const fUrl = f.relurl || f.url || ''
                  const fMatch = fUrl.match(/seg_(\d+)\.ts/)
                  const fAbs = fMatch ? parseInt(fMatch[1], 10) : f.sn
                  return fAbs === targetSync.segment
                })
                if (tFrag) {
                  const newTime = tFrag.start + targetSync.offset
                  if (Math.abs(targetVideo.currentTime - newTime) > 0.15) {
                    targetVideo.currentTime = newTime
                  }
                }
              }
            }
          } catch(e) { console.error('Sync failed', e) }
        }
      }
    } else {
      // In review mode, map targetCam currentTime according to syncMap
      const activeList = reviewSegs[activeCam]
      if (activeList && activeList.length > 0) {
        const activeSeg = activeList.find(s => currentVideo.currentTime >= s.start && currentVideo.currentTime <= s.end)
        if (activeSeg) {
          const offsetInSeg = currentVideo.currentTime - activeSeg.start
          const sn = activeSeg.absSegIdx
          const mapping = syncMap?.[sn]?.[targetCam]
          if (mapping) {
            const targetList = reviewSegs[targetCam]
            if (targetList) {
              const targetSeg = targetList.find(s => s.absSegIdx === mapping.segment)
              if (targetSeg) {
                targetVideo.currentTime = targetSeg.start + mapping.offset + offsetInSeg
              }
            }
          }
        }
      }
    }
    
    // update state
    setActiveCam(targetCam)
    setTimeout(() => {
      ignoreSyncRef.current = false
    }, 300)
  }

  const handleSeek = (time) => {
    const video = videoRefs[activeCam].current
    if (video) {
      video.currentTime = time
      if (mode === 'review') {
        syncReviewVideos(time)
      } else {
        syncLiveVideos(time)
      }
    }
  }

  const inReview = mode === 'review'
  const activeReviewSegs = inReview ? (reviewSegs[activeCam] || []) : []
  const displaySegments = inReview ? activeReviewSegs : liveSegments
  const displayLiveEdge = inReview ? (activeReviewSegs.length > 0 ? activeReviewSegs[activeReviewSegs.length - 1].end : null) : liveEdge
  const displayBufferStart = inReview ? 0 : bufferStart
  const displayBufferedEnd = inReview ? displayLiveEdge : bufferedEnd

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0a0a0a', color: '#fff' }}>
      <header style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #222' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <span style={{ fontWeight: 'bold', letterSpacing: '2px', fontSize: '18px' }}>TRIPLE-CAM REVIEW</span>
          <CameraSelector active={activeCam} onSwitch={handleSwitchCam} />
        </div>
        <div style={{ display: 'flex', gap: '16px' }}>
          <button 
            onClick={inReview ? exitReview : enterReview}
            style={{
              padding: '8px 24px', borderRadius: '4px', border: 'none', cursor: 'pointer',
              background: inReview ? '#4a90e2' : 'var(--amber, #f5a623)',
              color: '#000', fontWeight: 'bold', fontSize: '14px',
              boxShadow: '0 0 10px rgba(245,166,35,0.2)'
            }}
          >
            {inReview ? 'GO LIVE' : 'ENTER REVIEW'}
          </button>
        </div>
      </header>

      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {CAMERAS.map(cam => (
          <video
            key={cam}
            ref={videoRefs[cam]}
            muted={true}
            playsInline
            style={{
              width: '100%', height: '100%', objectFit: 'contain',
              position: 'absolute', inset: 0,
              opacity: cam === activeCam ? 1 : 0,
              pointerEvents: cam === activeCam ? 'auto' : 'none',
              transition: 'opacity 0.1s ease-in-out'
            }}
          />
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
             onEventSelect={setSelectedEvent}
             mode={mode}
             isPlaying={isPlaying}
             onTogglePlay={handleTogglePlay}
           />
        </div>

        <EventPanel event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      </div>
    </div>
  )
}
