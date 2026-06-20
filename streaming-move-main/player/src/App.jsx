import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import Hls from 'hls.js'
import SeekBar from './components/SeekBar.jsx'
import LiveBadge from './components/LiveBadge.jsx'
import CameraSelector from './components/CameraSelector.jsx'
import EventPanel from './components/EventPanel.jsx'

const REVIEW_BUFFER_SIZE = 35
const REVIEW_MASTER_CAM = 'hq'
const LIVE_THRESHOLD = 2
const EVENTS_POLL_INTERVAL = 2000

const LIVE_CONFIG = {
  enableWorker: true,
  lowLatencyMode: true,
  backBufferLength: 450, // Safely accommodates 30 segments of variable lengths (e.g. 5-6s each)
  liveSyncDurationCount: 1,
  liveMaxLatencyDurationCount: 1.5,
  liveDurationRatio: 1,
  manifestLoadingMaxRetry: 100,
  manifestLoadingRetryDelay: 500,
  maxBufferLength: 250,
  maxMaxBufferLength: 250,
  maxBufferSize: 800 * 1024 * 1024 // 500 MB limit to prevent bitrate bottlenecks
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

/** Map a server event to VOD-local time on the HQ review timeline (0 … snapshot duration). */
function reviewTimeFromEvent(ev, hqReviewSegs) {
  const bounceFrame = ev.bounce_frame ?? ev.metadata?.bounce_frame
  if (bounceFrame == null || bounceFrame === '' || !hqReviewSegs?.length) return null
  const segNum = ev.segments?.hq
  if (segNum == null) return null
  const offset = ev.offsets?.hq ?? 0
  const minAbs = hqReviewSegs[0].absSegIdx
  const maxAbs = hqReviewSegs[hqReviewSegs.length - 1].absSegIdx
  if (segNum < minAbs || segNum > maxAbs) return null
  const matchingSeg = hqReviewSegs.find(s => s.absSegIdx === segNum)
  if (!matchingSeg) return null
  return matchingSeg.localStart + offset
}

function buildReviewMappedEvents(eventsList, hqReviewSegs) {
  const byBounce = new Map()
  for (const ev of eventsList) {
    const time = reviewTimeFromEvent(ev, hqReviewSegs)
    if (time == null || !Number.isFinite(time)) continue
    const bf = ev.bounce_frame ?? ev.metadata?.bounce_frame
    const k = bf != null ? String(bf) : ev.id
    const mapped = { ...ev, time, startTime: time, endTime: time }
    const prev = byBounce.get(k)
    if (!prev || time >= prev.time) byBounce.set(k, mapped)
  }
  return [...byBounce.values()].sort((a, b) => a.time - b.time)
}

function waitForSeek(video) {
  return new Promise(resolve => {
    if (!video || !video.seeking) {
      resolve()
      return
    }
    const done = () => {
      video.removeEventListener('seeked', done)
      resolve()
    }
    video.addEventListener('seeked', done)
    setTimeout(done, 400)
  })
}

async function safePlay(video) {
  if (!video) return false
  await waitForSeek(video)
  try {
    await video.play()
    return true
  } catch (e) {
    if (e.name !== 'AbortError') console.log('play failed', e)
    return false
  }
}

/** True if time t falls inside any buffered range of the video (with small slack). */
function isTimeBuffered(video, t) {
  if (!video) return false
  for (let i = 0; i < video.buffered.length; i++) {
    if (t >= video.buffered.start(i) - 0.5 && t <= video.buffered.end(i) + 0.5) return true
  }
  return false
}

/** Start of the next buffered range strictly ahead of the playhead, or null. */
function findForwardPlayable(video) {
  if (!video || video.buffered.length === 0) return null
  const ct = video.currentTime
  for (let i = 0; i < video.buffered.length; i++) {
    const s = video.buffered.start(i)
    if (s > ct + 0.5) return s + 0.05
  }
  return null
}

export default function App() {
  const videoRefs = { source: useRef(null), sink: useRef(null), hq: useRef(null) }
  const hlsRefs = { source: useRef(null), sink: useRef(null), hq: useRef(null) }
  const rollingBuffers = { source: useRef([]), sink: useRef([]), hq: useRef([]) }
  const blobUrlsRef = useRef([])
  const segmentStartTimesRef = useRef({ source: {}, sink: {}, hq: {} })
  const hlsAnchoredSegsRef = useRef({ source: new Set(), sink: new Set(), hq: new Set() })
  const downloadingSegmentsRef = useRef({ source: new Set(), sink: new Set(), hq: new Set() })

  const rafRef = useRef(null)
  const modeRef = useRef('live')
  const lastTickRef = useRef(performance.now())
  const liveEdgeRef = useRef(null)
  const dvrActiveRef = useRef(false)
  const dvrTimeRef = useRef(null)
  const reviewEntryHoldRef = useRef(null)
  const isPlayingRef = useRef(true)

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
  const [timelineRevision, setTimelineRevision] = useState(0)
  const eventTimeCacheRef = useRef({})
  const bounceTimeLockRef = useRef({}) // bounce_frame -> { time, hlsLocked }
  const bumpTimeline = useCallback(() => setTimelineRevision(v => v + 1), [])
  const [reviewSegs, setReviewSegs] = useState({ source: [], sink: [], hq: [] })
  const [syncMap, setSyncMap] = useState(null)
  const [liveSyncMap, setLiveSyncMap] = useState({})
  const [selectedEvent, setSelectedEvent] = useState(null)
  const [isPlaying, setIsPlaying] = useState(true)

  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])

  const handleTogglePlay = useCallback(() => {
    setIsPlaying(prev => {
      const nextPlaying = !prev
      CAMERAS.forEach(cam => {
        const video = videoRefs[cam].current
        if (video) {
          if (nextPlaying) {
            if (modeRef.current === 'review') {
              // In review mode (local Blob URLs), play all cameras to keep them perfectly in sync in the background
              safePlay(video)
            } else {
              // In live mode, play all cameras to continually download segments in the background
              if (dvrActiveRef.current && dvrTimeRef.current != null) {
                video.currentTime = dvrTimeRef.current
              }
              safePlay(video)
            }
            // Resuming: stay in DVR until GO LIVE — never re-enable latency while behind live
            if (modeRef.current === 'live') {
              const hls = hlsRefs[cam].current
              if (hls) {
                const livePos = hls.liveSyncPosition
                const atLiveEdge = !dvrActiveRef.current
                  && livePos != null
                  && Math.abs(video.currentTime - livePos) < 2.0
                hls.config.liveMaxLatencyDurationCount = atLiveEdge
                  ? LIVE_CONFIG.liveMaxLatencyDurationCount
                  : 9999
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
  const isFirstPollRef = useRef({ source: true, sink: true, hq: true })
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

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch(`${backendUrl}/events`)
      const data = await res.json()
      setEvents(data)
      bumpTimeline()
    } catch (e) { console.warn('Failed to fetch events', e) }
  }, [bumpTimeline])

  useEffect(() => {
    if (mode === 'live') return
    fetchEvents()
    const interval = setInterval(fetchEvents, EVENTS_POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchEvents, mode])

  const bufferToSegs = useCallback((cam) => {
    return (rollingBuffers[cam].current || []).map(s => ({
      sn: s.sn,
      absSegIdx: s.absSegIdx,
      start: s.originalStart,
      end: s.originalStart + s.duration,
      duration: s.duration,
    }))
  }, [])

  const mappedEvents = useMemo(() => {
    if (mode === 'live') return []
    
    // Review: VOD-local HQ timeline only — never reuse live HLS absolute times.
    const hqSegs = reviewSegs[REVIEW_MASTER_CAM] || []
    if (hqSegs.length === 0) return []
    return buildReviewMappedEvents(events, hqSegs)
  }, [events, mode, reviewSegs])

  const syncReviewVideos = useCallback((activeTime) => {
    if (!syncMap) return
    const activeList = reviewSegs[activeCam]
    if (!activeList || activeList.length === 0) return

    const activeSeg = activeList.find(s => activeTime >= s.localStart && activeTime <= s.localEnd)
    if (!activeSeg) return

    const offsetInSeg = activeTime - activeSeg.localStart

    CAMERAS.forEach(cam => {
      if (cam === activeCam) return
      const mapping = syncMap[activeCam]?.[activeSeg.absSegIdx]?.[cam]
      if (!mapping) return

      const targetList = reviewSegs[cam]
      if (!targetList) return
      const targetSeg = targetList.find(s => s.absSegIdx === mapping.segment)
      if (targetSeg) {
        const targetTime = targetSeg.localStart + mapping.offset + offsetInSeg
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

  const seekCamToSyncPosition = useCallback((cam, syncInfo) => {
    const video = videoRefs[cam].current
    if (!video || !syncInfo) return false

    const targetSeg = syncInfo.segment
    const times = segmentStartTimesRef.current[cam] || {}
    let baseStart = times[targetSeg]

    // Nearest segment + scale (same idea as server /sync when exact row missing)
    if (baseStart === undefined) {
      const keys = Object.keys(times).map(Number)
      if (keys.length > 0) {
        const closest = keys.reduce((p, c) =>
          Math.abs(c - targetSeg) < Math.abs(p - targetSeg) ? c : p
        )
        baseStart = times[closest] + (targetSeg - closest) * 4.0
      }
    }

    // Fall back to loaded HLS fragment list
    if (baseStart === undefined) {
      const tDetails = hlsRefs[cam].current?.levels?.[hlsRefs[cam].current.currentLevel]?.details
      if (tDetails?.fragments?.length) {
        const tFrag = tDetails.fragments.find(f => {
          const m = (f.relurl || f.url || '').match(/seg_(\d+)\.ts/)
          return (m ? parseInt(m[1], 10) : f.sn) === targetSeg
        }) || tDetails.fragments.reduce((prev, curr) => {
          const prevM = (prev.relurl || prev.url || '').match(/seg_(\d+)\.ts/)
          const currM = (curr.relurl || curr.url || '').match(/seg_(\d+)\.ts/)
          const prevSn = prevM ? parseInt(prevM[1], 10) : prev.sn
          const currSn = currM ? parseInt(currM[1], 10) : curr.sn
          return Math.abs(currSn - targetSeg) < Math.abs(prevSn - targetSeg) ? curr : prev
        })
        const m = (tFrag.relurl || tFrag.url || '').match(/seg_(\d+)\.ts/)
        const actualSn = m ? parseInt(m[1], 10) : tFrag.sn
        baseStart = tFrag.start + (targetSeg - actualSn) * (tFrag.duration || 4.0)
      }
    }

    if (baseStart === undefined) return false

    const newTime = baseStart + syncInfo.offset
    const hls = hlsRefs[cam].current
    if (!isTimeBuffered(video, newTime) && hls) {
      // Target fell outside the buffer (long pause → evicted segments). Flush the
      // loader and restart it AT the target so HLS fetches it directly instead of
      // slow-catching-up from the old position (which causes visible jumps/desync).
      hls.stopLoad()
      video.currentTime = newTime
      hls.startLoad(newTime)
    } else if (Math.abs(video.currentTime - newTime) > 0.15) {
      video.currentTime = newTime
    }
    return true
  }, [])

  const syncLiveVideos = useCallback((activeTime, masterCam) => {
    if (!liveSyncMap) return
    const master = masterCam ?? activeCamRef.current
    const aHls = hlsRefs[master].current
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
      if (targetCam === master) return
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
          const activeFrame = mapping.searched_frame != null ? Math.round(mapping.searched_frame + offsetInSeg * 30) : 'N/A'
          const targetFrame = mapping.frame != null ? Math.round(mapping.frame + offsetInSeg * 30) : 'N/A'
          console.log(
            `[SYNC SCRUB] ${master} → ${targetCam} | ` +
            `Current: ${activeFrame} | ` +
            `Target: ${targetFrame}`
          )
          if (Math.abs(targetVideo.currentTime - targetTime) > 0.15) {
            targetVideo.currentTime = targetTime
          }
        }
      }
    })
  }, [liveSyncMap])

  const tick = useCallback(() => {
    // Read the live ref, not a captured closure — the rAF loop is started once at
    // mount, so using `activeCam` here would forever read the mount-time camera (hq)
    // and freeze the playhead when switched to sink/source (which pause hq).
    const cam = activeCamRef.current
    const video = videoRefs[cam].current
    const hls = hlsRefs[cam].current
    if (video) {
      const now = performance.now()
      const dt = (now - lastTickRef.current) / 1000
      lastTickRef.current = now

      let globalTime = video.currentTime;
      if (modeRef.current === 'review') {
        const hqVideo = videoRefs[REVIEW_MASTER_CAM].current
        const entryHold = reviewEntryHoldRef.current
        if (entryHold != null) {
          globalTime = entryHold
          if (hqVideo && !hqVideo.seeking && Math.abs(hqVideo.currentTime - entryHold) < 0.25) {
            reviewEntryHoldRef.current = null
          }
        } else if (hqVideo) {
          globalTime = hqVideo.currentTime
        }
        if (hqVideo && hqVideo.buffered.length > 0) {
          setBufferStart(0)
          setBufferedEnd(hqVideo.buffered.end(hqVideo.buffered.length - 1))
        }
      } else if (dvrActiveRef.current && video.paused && dvrTimeRef.current != null) {
        // While paused in DVR, keep UI playhead where the user scrubbed — don't follow HLS snap-to-live.
        globalTime = dvrTimeRef.current
      } else if (dvrActiveRef.current && !video.paused) {
        const livePos = hls?.liveSyncPosition
        const saved = dvrTimeRef.current
        if (livePos != null && Math.abs(globalTime - livePos) < 2.5) {
          dvrActiveRef.current = false
          dvrTimeRef.current = null
        } else if (livePos != null && saved != null
          && Math.abs(globalTime - livePos) < 2
          && livePos - saved > 5) {
          video.currentTime = saved
          if (hls) hls.config.liveMaxLatencyDurationCount = 9999
          globalTime = saved
        } else {
          dvrTimeRef.current = globalTime
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
        if (hls?.liveSyncPosition && !video.seeking && !dvrActiveRef.current) {
          const drift = Math.abs(edge - hls.liveSyncPosition)
          if (drift > 3.0) {
            edge = hls.liveSyncPosition
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
          // Sync actively playing videos to prevent drift over time
          if (!video.paused) {
            syncReviewVideos(globalTime)
          }
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

    // Check for GAP segments to show "NO FRAMES" precisely aligned with playhead.
    // Use functional setState so we compare against the latest value (the rAF loop
    // captures a mount-time closure, so reading `gapState` directly would be stale).
    const nextGap = {}
    CAMERAS.forEach(c => {
      const v = videoRefs[c].current
      const h = hlsRefs[c].current
      if (v && h && v.readyState >= 2) { // Ensure there is enough data
        const ct = v.currentTime
        const details = h.levels?.[h.currentLevel]?.details
        if (details) {
          const frag = details.fragments.find(f => f.start <= ct && f.start + f.duration >= ct + 0.1) ||
            details.fragments.find(f => Math.abs(f.start - ct) < 1.0)
          if (frag) {
            const url = frag.relurl || frag.url || ''
            nextGap[c] = url.includes(`gap_${c}.ts`)
          }
        }
      }
    })

    setGapState(prev => {
      let changed = false
      const merged = { ...prev }
      for (const c of CAMERAS) {
        if (nextGap[c] !== undefined && nextGap[c] !== prev[c]) {
          merged[c] = nextGap[c]
          changed = true
        }
      }
      return changed ? merged : prev
    })

    rafRef.current = requestAnimationFrame(tick)
  }, [])

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
          safePlay(video)
        }
      })

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log(`[HLS] Fatal network error for ${cam}, trying to recover...`);
              if (data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR) {
                const livePos = hls.liveSyncPosition;
                if (livePos != null && !dvrActiveRef.current && !video.paused) {
                  const behind = livePos - video.currentTime;
                  if (behind <= 12) {
                    // At/near live: a fragment briefly 404'd (slow Pi) → recover to live edge.
                    console.log(`[HLS] Fragment missing near live, recovering to live edge.`);
                    if (cam === activeCamRef.current) {
                      hls.config.liveMaxLatencyDurationCount = LIVE_CONFIG.liveMaxLatencyDurationCount;
                    }
                    video.currentTime = livePos;
                  } else {
                    // DVR territory (e.g. resumed after a long pause and hit an evicted
                    // gap): hop to the next available buffered region instead of snapping
                    // all the way to live. Keep latency disabled so we aren't yanked forward.
                    const next = findForwardPlayable(video);
                    if (next != null) {
                      console.log(`[HLS] Evicted gap in DVR, hopping to next buffered region @ ${next.toFixed(2)}s.`);
                      video.currentTime = next;
                      hls.config.liveMaxLatencyDurationCount = 9999;
                    } else {
                      // Nothing buffered ahead — unavoidable: jump to live to avoid stalling.
                      console.log(`[HLS] No buffered data ahead, jumping to live edge.`);
                      if (cam === activeCamRef.current) {
                        hls.config.liveMaxLatencyDurationCount = LIVE_CONFIG.liveMaxLatencyDurationCount;
                      }
                      video.currentTime = livePos;
                    }
                  }
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
        const hlsStart = data.frag.start

        segmentStartTimesRef.current[cam][absSegIdx] = hlsStart
        if (!hlsAnchoredSegsRef.current[cam]) hlsAnchoredSegsRef.current[cam] = new Set()
        hlsAnchoredSegsRef.current[cam].add(absSegIdx)

        if (existingSeg) {
          if (Math.abs(existingSeg.originalStart - hlsStart) > 0.01) {
            rollingBuffers[cam].current = existing.map(s =>
              s.absSegIdx === absSegIdx ? { ...s, originalStart: hlsStart } : s
            )
            if (cam === activeCamRef.current && modeRef.current === 'live') {
              setLiveSegments(rollingBuffers[cam].current.map(s => ({
                sn: s.sn,
                absSegIdx: s.absSegIdx,
                start: s.originalStart,
                end: s.originalStart + s.duration
              })))
            }
            bumpTimeline()
          }
        } else {
          const entry = {
            sn: data.frag.sn,
            absSegIdx: absSegIdx,
            originalStart: hlsStart,
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
          bumpTimeline()
        }
      })
    })
    modeRef.current = 'live'
    setMode('live')
  }, [bumpTimeline])

  const seekReviewToTime = useCallback((time, segsByCam, map) => {
    const master = REVIEW_MASTER_CAM
    const activeSegs = segsByCam[master]
    if (!activeSegs?.length) return

    const seg = activeSegs.find(s => time >= s.localStart && time <= s.localEnd)
      || activeSegs.reduce((p, c) =>
        Math.abs(c.localStart + c.duration / 2 - time) < Math.abs(p.localStart + p.duration / 2 - time) ? c : p
      )
    const offsetInSeg = seg ? time - seg.localStart : 0

    CAMERAS.forEach(cam => {
      const v = videoRefs[cam].current
      if (!v) return

      let seekTime = time
      if (cam !== master && seg) {
        const mapping = map?.[master]?.[seg.absSegIdx]?.[cam]
        const targetSeg = segsByCam[cam]?.find(s => s.absSegIdx === mapping?.segment)
        if (mapping && targetSeg) {
          seekTime = targetSeg.localStart + mapping.offset + offsetInSeg
          const activeFrame = mapping.searched_frame != null ? Math.round(mapping.searched_frame + offsetInSeg * 30) : 'N/A'
          const targetFrame = mapping.frame != null ? Math.round(mapping.frame + offsetInSeg * 30) : 'N/A'
          console.log(
            `[SYNC SCRUB] ${master} → ${cam} | ` +
            `Current: ${activeFrame} | ` +
            `Target: ${targetFrame}`
          )
        }
      }
      v.currentTime = Math.max(0, seekTime)
      v.pause()
    })
    setCurrentTime(time)
  }, [])

  const enterReview = useCallback(async () => {
    console.log('[MODE] Entering Review Mode')
    if (rollingBuffers[activeCam].current.length === 0) return false

    const newReviewSegs = { source: [], sink: [], hq: [] }
    CAMERAS.forEach(cam => {
      const snapshot = rollingBuffers[cam].current.slice()
      let t = 0
      newReviewSegs[cam] = snapshot.map(s => {
        const seg = {
          sn: s.sn,
          absSegIdx: s.absSegIdx,
          start: t,
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

    const pendingSeekTime = 0

    let fullMap = {}
    try {
      const results = await Promise.all(CAMERAS.map(c => {
        const sns = rollingBuffers[c].current.map(s => s.absSegIdx).join(',')
        if (!sns) return Promise.resolve({ cam: c, data: {} })
        return fetch(`${backendUrl}/sync_map?from_camera=${c}&sns=${sns}`)
          .then(res => res.json())
          .then(data => ({ cam: c, data }))
      }))
      results.forEach(r => { fullMap[r.cam] = r.data })
    } catch (e) {
      console.error('Failed to fetch full sync map', e)
    }

    let manifestsReady = 0
    const finishReviewEntrySeek = async () => {
      seekReviewToTime(pendingSeekTime, newReviewSegs, fullMap, activeCam)
      await Promise.all(CAMERAS.map(cam => waitForSeek(videoRefs[cam].current)))
      // Start buffering from the seek point (latest bounce), NOT from position 0.
      // startLoad(-1) would make HLS.js fetch segments from 0 forward, so when the
      // user hits play at pendingSeekTime nothing is buffered there yet — causing the
      // sequential "fast-forward loading" artifact and the wrong playhead position.
      // Passing pendingSeekTime tells HLS.js to begin fetching from that offset.
      CAMERAS.forEach(cam => {
        const hls = hlsRefs[cam].current
        if (hls && modeRef.current === 'review') hls.startLoad(pendingSeekTime)
      })
    }

    CAMERAS.forEach(cam => {
      const snapshot = rollingBuffers[cam].current.slice()
      const fragUrls = snapshot.map(s => URL.createObjectURL(new Blob([s.bytes], { type: 'video/mp2t' })))
      const m3u8 = buildReviewPlaylist(snapshot, fragUrls)
      const m3u8Url = URL.createObjectURL(new Blob([m3u8], { type: 'application/vnd.apple.mpegurl' }))
      blobUrlsRef.current.push(...fragUrls, m3u8Url)

      hlsRefs[cam].current?.destroy()

      const hls = new Hls(REVIEW_CONFIG)
      hlsRefs[cam].current = hls
      hls.once(Hls.Events.MANIFEST_PARSED, () => {
        manifestsReady += 1
        if (manifestsReady === CAMERAS.length) {
          finishReviewEntrySeek()
        }
      })
      hls.loadSource(m3u8Url)
      hls.attachMedia(videoRefs[cam].current)
    })

    setReviewSegs(newReviewSegs)
    setSyncMap(fullMap)
    setIsPlaying(false)
    setSelectedEvent(null)
    reviewEntryHoldRef.current = pendingSeekTime
    setCurrentTime(pendingSeekTime)
    setLiveEdge(null)
    setBufferStart(null)
    setBufferedEnd(null)
    modeRef.current = 'review'
    setMode('review')

    try {
      const res = await fetch(`${backendUrl}/events`)
      const data = await res.json()
      setEvents(data)
      
      const visibleBounces = new Set()
      const hqSegs = newReviewSegs[REVIEW_MASTER_CAM] || []
      const minAbs = hqSegs[0]?.absSegIdx
      const maxAbs = hqSegs[hqSegs.length - 1]?.absSegIdx
      if (minAbs != null && maxAbs != null) {
        data.forEach(ev => {
          const segNum = ev.segments?.[REVIEW_MASTER_CAM]
          if (segNum >= minAbs && segNum <= maxAbs) {
            const bf = ev.bounce_frame ?? ev.metadata?.bounce_frame
            if (bf != null && bf !== '') visibleBounces.add(Number(bf))
          }
        })
      }
      
      const bounceFrames = Array.from(visibleBounces)
      if (bounceFrames.length > 0) {
        fetch(`${backendUrl}/prefetch_bounces`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bounce_frames: bounceFrames })
        }).catch(e => console.warn('Prefetch failed', e))
      }
    } catch(e) {
      console.warn('Failed to fetch events on review entry', e)
    }

    return true
  }, [activeCam, events, seekReviewToTime])

  const exitReview = useCallback(() => {
    console.log('[MODE] Exiting Review Mode (returning to Live)')
    
    fetch(`${backendUrl}/clear_bounces`, { method: 'POST' })
      .catch(e => console.warn('Failed to clear bounces', e))

    CAMERAS.forEach(cam => {
      hlsRefs[cam].current?.destroy()
      hlsRefs[cam].current = null
    })
    blobUrlsRef.current.forEach(URL.revokeObjectURL)
    blobUrlsRef.current = []

    // Clear Review UI timeline AND clear Live DVR history (to prevent seeking to evicted server segments)
    setReviewSegs({ source: [], sink: [], hq: [] })
    setSyncMap(null)
    setSelectedEvent(null)
    reviewEntryHoldRef.current = null
    setPlaybackRate(1.0)

    CAMERAS.forEach(cam => {
      rollingBuffers[cam].current = []
      segmentStartTimesRef.current[cam] = {}
      hlsAnchoredSegsRef.current[cam].clear()
      downloadingSegmentsRef.current[cam].clear()
      isFirstPollRef.current[cam] = true
    })
    setLiveSegments([])
    setLiveSyncMap({})

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

          if (playlistSegs.length > 0 && isFirstPollRef.current[cam]) {
            isFirstPollRef.current[cam] = false;
            // Ignore any segment that was strictly BEFORE the last 2 segments in the playlist
            // so we don't fetch the massive 35-segment history when we just joined.
            cutoffAbsSegIdxRef.current[cam] = playlistSegs[playlistSegs.length - 1].absSegIdx - 2;
          }

          // Compute start times — chain through playlist durations; never overwrite HLS anchors
          if (!segmentStartTimesRef.current[cam]) {
            segmentStartTimesRef.current[cam] = {}
          }
          let timesAdded = false
          for (let i = 0; i < playlistSegs.length; i++) {
            const seg = playlistSegs[i]
            if (hlsAnchoredSegsRef.current[cam]?.has(seg.absSegIdx)) continue
            if (segmentStartTimesRef.current[cam][seg.absSegIdx] !== undefined) continue
            timesAdded = true

            if (i > 0) {
              const prevSeg = playlistSegs[i - 1]
              const prevStart = segmentStartTimesRef.current[cam][prevSeg.absSegIdx]
              if (prevStart !== undefined) {
                segmentStartTimesRef.current[cam][seg.absSegIdx] = prevStart + prevSeg.duration
                continue
              }
            }

            const keys = Object.keys(segmentStartTimesRef.current[cam]).map(Number).sort((a, b) => a - b)
            if (keys.length > 0) {
              const closest = keys.reduce((prev, curr) =>
                Math.abs(curr - seg.absSegIdx) < Math.abs(prev - seg.absSegIdx) ? curr : prev
              )
              const closestStart = segmentStartTimesRef.current[cam][closest]
              const bufSeg = rollingBuffers[cam].current.find(s => s.absSegIdx === closest)
              const stepDur = bufSeg?.duration ?? 6.0
              segmentStartTimesRef.current[cam][seg.absSegIdx] =
                closestStart + (seg.absSegIdx - closest) * stepDur
            } else {
              segmentStartTimesRef.current[cam][seg.absSegIdx] = seg.absSegIdx * seg.duration
            }
          }
          if (timesAdded) bumpTimeline()

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
                bumpTimeline()
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
  }, [activeCam, setLiveSegments, setLiveSyncMap, bumpTimeline]);

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

  const goLive = useCallback(async () => {
    if (modeRef.current === 'review') {
      exitReview()
    }
    
    fetch(`${backendUrl}/clear_bounces`, { method: 'POST' })
      .catch(e => console.warn('Failed to clear bounces', e))
      
    console.log('[SEEK] Jumping to Live Edge')
    dvrActiveRef.current = false
    dvrTimeRef.current = null

    const masterCam = activeCamRef.current
    const masterHls = hlsRefs[masterCam].current
    const masterVideo = videoRefs[masterCam].current
    if (!masterHls || !masterVideo) return

    ignoreSyncRef.current = true

    // Use HLS.js live edge — not the smoothed UI estimate (which drifts while paused)
    let livePos = masterHls.liveSyncPosition
    if (livePos == null || !Number.isFinite(livePos)) {
      livePos = liveEdgeRef.current
    }
    if (livePos == null || !Number.isFinite(livePos)) {
      ignoreSyncRef.current = false
      return
    }

    // Is the live edge already inside the buffered range? (short pause)
    let liveBuffered = false
    for (let i = 0; i < masterVideo.buffered.length; i++) {
      if (livePos >= masterVideo.buffered.start(i) - 0.5 &&
          livePos <= masterVideo.buffered.end(i) + 0.5) {
        liveBuffered = true
        break
      }
    }

    CAMERAS.forEach(cam => {
      const hls = hlsRefs[cam].current
      if (hls) {
        hls.config.liveMaxLatencyDurationCount = (cam === masterCam)
          ? LIVE_CONFIG.liveMaxLatencyDurationCount
          : 9999
      }
    })

    // Jump to the live edge on the existing MSE timeline
    if (!liveBuffered) {
      masterHls.stopLoad()
      masterVideo.currentTime = livePos
      masterHls.startLoad(livePos)
    } else {
      masterVideo.currentTime = livePos
      if (masterHls.streamController?.paused) {
        masterHls.startLoad(livePos)
      }
    }
    liveEdgeRef.current = livePos
    setLiveEdge(livePos)

    // Sync other cameras to livePos
    let syncData = null
    const details = masterHls.levels?.[masterHls.currentLevel]?.details
    if (details) {
      let frag = details.fragments.find(f => f.start <= livePos && f.start + f.duration >= livePos)
      if (!frag && details.fragments.length > 0) {
        frag = details.fragments.reduce((prev, curr) => {
          const prevDist = Math.abs((prev.start + prev.duration / 2) - livePos)
          const currDist = Math.abs((curr.start + curr.duration / 2) - livePos)
          return currDist < prevDist ? curr : prev
        })
      }
      if (frag) {
        const offset = livePos - frag.start
        const url = frag.relurl || frag.url || ''
        const match = url.match(/seg_(\d+)\.ts/)
        const absSegIdx = match ? parseInt(match[1], 10) : frag.sn
        try {
          const res = await fetch(`${backendUrl}/sync?from_camera=${masterCam}&from_seg=${absSegIdx}&from_offset=${offset}`)
          if (res.ok) syncData = await res.json()
        } catch (e) { console.error('Sync failed', e) }
      }
    }

    if (syncData) {
      CAMERAS.forEach(cam => {
        if (cam !== masterCam && syncData[cam]) {
          console.log(`[SYNC SWITCH (GO LIVE)] ${masterCam} → ${cam} | Target: ${syncData[cam].frame}`)
          seekCamToSyncPosition(cam, syncData[cam])
        }
      })
    }

    if (isPlaying) {
      CAMERAS.forEach(cam => {
        const v = videoRefs[cam].current
        if (v) safePlay(v)
      })
    }

    setTimeout(() => {
      ignoreSyncRef.current = false
    }, 500)
  }, [isPlaying, seekCamToSyncPosition])

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
          const currentActive = activeCamRef.current;
          console.log(`[SYNC LOG] ACTIVE (${currentActive}): seg ${pos[currentActive].seg}, frame ${v.frames[currentActive]}`)
        }
      } catch (_) { }
    }
    const id = setInterval(poll, 3333)
    return () => clearInterval(id)
  }, [getAllCamPositions])

  const handleSwitchCam = async (targetCam) => {
    if (targetCam === activeCam) return
    const fromCam = activeCam
    const currentVideo = videoRefs[fromCam].current
    const targetVideo = videoRefs[targetCam].current
    if (!currentVideo || !targetVideo) return

    ignoreSyncRef.current = true
    const shouldPlay = isPlaying

    try {
      if (mode === 'live') {
        let isLive = false
        let syncData = null
        const hls = hlsRefs[fromCam].current
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
              const res = await fetch(`${backendUrl}/sync?from_camera=${fromCam}&from_seg=${absSegIdx}&from_offset=${offset}`)
              if (res.ok) syncData = await res.json()
            } catch (e) { console.error('Sync failed', e) }
          }
        }

        if (syncData) {
          CAMERAS.forEach(cam => {
            if (cam !== fromCam && syncData[cam]) {
              console.log(
                `[SYNC SWITCH] ${fromCam} → ${cam} | ` +
                `Current: ${syncData[cam].searched_frame} | ` +
                `Target: ${syncData[cam].frame}`
              )
            }
            seekCamToSyncPosition(cam, syncData[cam])
          })
        }

        const hlsTarget = hlsRefs[targetCam].current
        const hlsCurrent = hlsRefs[fromCam].current
        if (hlsTarget) {
          hlsTarget.config.liveMaxLatencyDurationCount = (isLive && shouldPlay) ? LIVE_CONFIG.liveMaxLatencyDurationCount : 9999
        }
        if (hlsCurrent) {
          hlsCurrent.config.liveMaxLatencyDurationCount = 9999
        }

        // Sync liveSegments to target buffer before activeCam state flips (prevents dot flash)
        const targetBuf = rollingBuffers[targetCam].current
        setLiveSegments(targetBuf.map(s => ({
          sn: s.sn,
          absSegIdx: s.absSegIdx,
          start: s.originalStart,
          end: s.originalStart + s.duration
        })))
        bumpTimeline()

        activeCamRef.current = targetCam
        setActiveCam(targetCam)

        if (dvrActiveRef.current) {
          dvrTimeRef.current = targetVideo.currentTime
        }

        if (shouldPlay) {
          let played = await safePlay(targetVideo)
          if (!played) {
            const livePos = hlsTarget?.liveSyncPosition
            if (livePos != null) {
              targetVideo.currentTime = livePos
              played = await safePlay(targetVideo)
            }
          }
        }
      } else {
        const currentLocal = currentVideo.currentTime
        const currentSegs = reviewSegs[fromCam]
        
        let newTargetTime = null
        if (currentSegs?.length > 0) {
          const seg = currentSegs.find(s => currentLocal >= s.localStart && currentLocal <= s.localEnd) || currentSegs[0]
          const mapping = syncMap?.[fromCam]?.[seg.absSegIdx]?.[targetCam]
          if (mapping) {
            const offsetInSeg = currentLocal - seg.localStart
            const activeFrame = mapping.searched_frame != null ? Math.round(mapping.searched_frame + offsetInSeg * 30) : 'N/A'
            const targetFrame = mapping.frame != null ? Math.round(mapping.frame + offsetInSeg * 30) : 'N/A'
            console.log(
              `[SYNC SWITCH] ${fromCam} → ${targetCam} | ` +
              `Current: ${activeFrame} | ` +
              `Target: ${targetFrame}`
            )
            
            const targetSeg = reviewSegs[targetCam]?.find(s => s.absSegIdx === mapping.segment)
            if (targetSeg) {
              newTargetTime = targetSeg.localStart + mapping.offset + offsetInSeg
            }
          }
        }

        if (newTargetTime !== null) {
          targetVideo.currentTime = Math.max(0, newTargetTime)
        } else {
          console.warn(`[SYNC] missing in triple csv - sync_map was not able to create sync for ${fromCam} → ${targetCam}`)
        }

        bumpTimeline()
        activeCamRef.current = targetCam
        setActiveCam(targetCam)

        if (shouldPlay) {
          await safePlay(targetVideo)
        }
      }
    } finally {
      setTimeout(() => {
        ignoreSyncRef.current = false
      }, 300)
    }
  }

  const handleSeek = async (time, forcePause = false) => {
    const video = videoRefs[activeCam].current
    if (video) {
      if (mode === 'review') {
        reviewEntryHoldRef.current = null
        setCurrentTime(time)
        seekReviewToTime(time, reviewSegs, syncMap, activeCam)
        setIsPlaying(false)
      } else {
        // GO LIVE button seeks to liveEdge — jump to real HLS live position and resume
        const livePos = liveEdgeRef.current
        const isLiveEdge = livePos != null && time >= livePos - 2.0
        if (isLiveEdge) {
          if (forcePause) {
            setIsPlaying(false)
            CAMERAS.forEach(cam => videoRefs[cam].current?.pause())
            video.currentTime = livePos
          } else {
            goLive()
          }
        } else {
          // Seeking to a past segment: pause and stay in DVR until GO LIVE
          dvrActiveRef.current = true
          dvrTimeRef.current = time
          setCurrentTime(time)
          ignoreSyncRef.current = true

          CAMERAS.forEach(cam => {
            if (hlsRefs[cam].current) {
              hlsRefs[cam].current.config.liveMaxLatencyDurationCount = 9999
            }
            if (videoRefs[cam].current) {
              videoRefs[cam].current.pause()
            }
          })

          const hls = hlsRefs[activeCam].current
          if (hls) {
            const details = hls.levels?.[hls.currentLevel]?.details
            if (details) {
              let frag = details.fragments.find(f => f.start <= time && f.start + f.duration >= time)
              if (!frag && details.fragments.length > 0) {
                frag = details.fragments.reduce((prev, curr) => {
                  const prevDist = Math.abs((prev.start + prev.duration / 2) - time)
                  const currDist = Math.abs((curr.start + curr.duration / 2) - time)
                  return currDist < prevDist ? curr : prev
                })
              }
              if (frag) {
                const offset = time - frag.start
                const url = frag.relurl || frag.url || ''
                const match = url.match(/seg_(\d+)\.ts/)
                const absSegIdx = match ? parseInt(match[1], 10) : frag.sn
                try {
                  const res = await fetch(`${backendUrl}/sync?from_camera=${activeCam}&from_seg=${absSegIdx}&from_offset=${offset}`)
                  if (res.ok) {
                    const syncData = await res.json()
                    CAMERAS.forEach(cam => {
                      if (cam !== activeCam && syncData[cam]) {
                        console.log(`[SYNC SWITCH (SEEK)] ${activeCam} → ${cam} | Target: ${syncData[cam].frame}`)
                        seekCamToSyncPosition(cam, syncData[cam])
                      }
                    })
                  }
                } catch (e) { console.error('Sync failed', e) }
              }
            }
          }

          video.currentTime = time
          // Disabled real-time bg sync during seek, rely on manual /sync call above
          // syncLiveVideos(time)

          setIsPlaying(false)

          setTimeout(() => {
            ignoreSyncRef.current = false
          }, 500)
        }
      }
    }
  }


  const inReview = mode === 'review'
  const activeReviewSegs = inReview ? (reviewSegs[REVIEW_MASTER_CAM] || []) : []
  const displaySegments = inReview ? activeReviewSegs : liveSegments
  const displayLiveEdge = inReview ? (activeReviewSegs.length > 0 ? activeReviewSegs[activeReviewSegs.length - 1].end : null) : liveEdge
  // Force the left edge of the timeline to perfectly lock to the 30-segment window, ignoring HLS.js's "zombie" cache
  const displayBufferStart = inReview ? 0 : (liveSegments.length > 0 ? liveSegments[0].start : bufferStart)
  const displayBufferedEnd = inReview ? (bufferedEnd ?? displayLiveEdge) : bufferedEnd

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0a0a0a', color: '#fff' }}>
      <header style={{ padding: '16px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #222' }}>
        {/* Left: brand + camera tabs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, flexWrap: 'nowrap', flexShrink: 0 }}>
          <span style={{ fontWeight: 'bold', letterSpacing: '2px', fontSize: '16px', whiteSpace: 'nowrap', flexShrink: 0 }}>Judex AI</span>
          <CameraSelector active={activeCam} onSwitch={handleSwitchCam} />
        </div>
        {/* Center: current mode */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <span style={{
            fontSize: '13px', fontWeight: '700', letterSpacing: '3px', textTransform: 'uppercase',
            padding: '5px 16px', borderRadius: '20px',
            background: inReview ? 'rgba(74,144,226,0.15)' : 'rgba(232,232,232,0.08)',
            color: inReview ? '#4a90e2' : '#e8e8e8',
            border: inReview ? '1px solid rgba(74,144,226,0.35)' : '1px solid rgba(232,232,232,0.25)',
          }}>
            {inReview ? 'Review' : 'Live'}
          </span>
        </div>
        {/* Right: mode toggle button */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
          <button
            onClick={inReview ? exitReview : enterReview}
            style={{
              padding: '6px 16px', borderRadius: '6px', border: 'none', cursor: 'pointer',
              background: inReview ? 'linear-gradient(135deg, #4a90e2, #2e6db4)' : 'linear-gradient(135deg, #e8e8e8, #c0c0c0)',
              color: '#000', fontWeight: '800', fontSize: '11px', letterSpacing: '1px',
              boxShadow: inReview ? '0 4px 15px rgba(74, 144, 226, 0.4)' : '0 4px 15px rgba(232, 232, 232, 0.2)',
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
