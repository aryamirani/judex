import { useEffect, useRef, useState, useCallback } from 'react'
import Hls from 'hls.js'
import SeekBar from './SeekBar.jsx'
import LiveBadge from './LiveBadge.jsx'
import SegmentList from './SegmentList.jsx'

// How many of the most recent segments to keep pinned in JS memory for
// instant replay. Memory cost grows linearly: ~6 MB per 1080p segment.
//   30  → ~180 MB
//   60  → ~360 MB
//   200 → ~1.2 GB (practical ceiling for 1080p on desktop)
export const REVIEW_BUFFER_SIZE = 30

const LIVE_CONFIG = {
  backBufferLength:            60,
  maxBufferLength:             60,
  liveSyncDurationCount:        3,
  liveMaxLatencyDurationCount:  6,
  enableWorker:                true,
  lowLatencyMode:              false,
}

const REVIEW_CONFIG = {
  enableWorker:     true,
  maxBufferLength:  60,
  backBufferLength: 60,
}

const LIVE_THRESHOLD = 2

// Build a VOD m3u8 referencing the supplied blob URLs as fragments.
function buildReviewPlaylist(segments, blobUrls) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ]
  for (let i = 0; i < segments.length; i++) {
    lines.push(`#EXTINF:${segments[i].duration.toFixed(6)},`)
    lines.push(blobUrls[i])
  }
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n')
}

export default function Player({ src }) {
  const videoRef         = useRef(null)
  const hlsRef           = useRef(null)
  const rafRef           = useRef(null)
  const hoverTimer       = useRef(null)
  const segEndRef        = useRef(null)             // auto-pause boundary
  const rollingBufferRef = useRef([])               // [{sn, originalStart, duration, bytes}]
  const blobUrlsRef      = useRef([])               // urls to revoke on Go Live
  const modeRef          = useRef('live')           // synchronous mirror of mode

  const [status,       setStatus]       = useState('connecting')
  const [mode,         setMode]         = useState('live')   // 'live' | 'review'
  const [showControls, setShowControls] = useState(true)
  const [showSegList,  setShowSegList]  = useState(false)
  const [currentTime,  setCurrentTime]  = useState(0)
  const [liveEdge,     setLiveEdge]     = useState(null)
  const [bufferStart,  setBufferStart]  = useState(null)
  const [bufferedEnd,  setBufferedEnd]  = useState(null)
  const [liveSegments, setLiveSegments] = useState([])       // metadata mirror of rolling buffer
  const [reviewSegs,   setReviewSegs]   = useState([])       // DVR-local timeline segments
  const [errorMsg,     setErrorMsg]     = useState(null)
  const [isPaused,     setIsPaused]     = useState(false)
  const [snapshot,     setSnapshot]     = useState(null)

  const isLive =
    mode === 'live' &&
    liveEdge !== null &&
    currentTime >= liveEdge - LIVE_THRESHOLD

  const setModeBoth = useCallback((m) => {
    modeRef.current = m
    setMode(m)
  }, [])

  // ---- RAF tick ------------------------------------------------------------
  const tick = useCallback(() => {
    const video = videoRef.current
    const hls   = hlsRef.current
    if (!video) {
      rafRef.current = requestAnimationFrame(tick)
      return
    }

    setCurrentTime(video.currentTime)
    setIsPaused(video.paused)

    if (modeRef.current === 'live' && hls) {
      const syncPos = hls.liveSyncPosition
      if (syncPos != null && Number.isFinite(syncPos)) setLiveEdge(syncPos)
    }

    if (video.buffered.length > 0) {
      setBufferStart(video.buffered.start(0))
      setBufferedEnd(video.buffered.end(video.buffered.length - 1))
    }

    rafRef.current = requestAnimationFrame(tick)
  }, [])

  // ---- Live mode setup -----------------------------------------------------
  const initLive = useCallback(() => {
    const video = videoRef.current
    if (!video) return

    const hls = new Hls(LIVE_CONFIG)
    hlsRef.current = hls
    hls.loadSource(src)
    hls.attachMedia(video)

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setStatus('playing')
      video.play().catch(() => {})
    })

    // Capture the raw bytes of every fragment into the rolling buffer.
    hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
      const payload = data.payload
      if (!payload || !payload.byteLength) return

      const entry = {
        sn:            data.frag.sn,
        originalStart: data.frag.start,
        duration:      data.frag.duration,
        bytes:         payload.slice(0),   // copy — hls.js may reuse the buffer
      }

      const next = [...rollingBufferRef.current, entry].slice(-REVIEW_BUFFER_SIZE)
      rollingBufferRef.current = next

      // mirror metadata to state so the seek-bar tick marks update
      setLiveSegments(next.map(s => ({
        sn:    s.sn,
        start: s.originalStart,
        end:   s.originalStart + s.duration,
      })))
    })

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        setStatus('error')
        setErrorMsg(`Fatal: ${data.type} — ${data.details}`)
      }
    })

    setModeBoth('live')
  }, [src, setModeBoth])

  // ---- Enter review mode ---------------------------------------------------
  const enterReview = useCallback(() => {
    const video = videoRef.current
    if (!video) return false

    const snapshot = rollingBufferRef.current.slice()
    if (snapshot.length === 0) {
      console.warn('[review] no segments captured yet')
      return false
    }

    // Build blob URLs for every segment's bytes.
    const fragUrls = snapshot.map(s =>
      URL.createObjectURL(new Blob([s.bytes], { type: 'video/mp2t' }))
    )

    // Build the VOD m3u8 and wrap it in its own blob URL.
    const m3u8 = buildReviewPlaylist(snapshot, fragUrls)
    const m3u8Url = URL.createObjectURL(
      new Blob([m3u8], { type: 'application/vnd.apple.mpegurl' })
    )

    // Remember every URL so we can revoke on exit.
    blobUrlsRef.current = [...fragUrls, m3u8Url]

    // Build DVR-local timeline ({start, end} relative to the new VOD's 0).
    let t = 0
    const localSegs = snapshot.map(s => {
      const seg = {
        sn:            s.sn,
        start:         t,
        end:           t + s.duration,
        duration:      s.duration,
        originalStart: s.originalStart,
      }
      t += s.duration
      return seg
    })
    setReviewSegs(localSegs)

    // Destroy live hls — frees its MSE buffer and stops the network.
    hlsRef.current?.destroy()
    hlsRef.current = null
    setLiveEdge(null)
    setBufferStart(null)
    setBufferedEnd(null)

    setModeBoth('review')

    // Spin up review hls.
    const hls = new Hls(REVIEW_CONFIG)
    hlsRef.current = hls
    hls.loadSource(m3u8Url)
    hls.attachMedia(video)

    hls.once(Hls.Events.MANIFEST_PARSED, () => {
      video.currentTime = 0
      // paused — user clicks a segment to play it
    })
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) console.error('[review] hls error', data)
    })

    video.pause()
    return true
  }, [setModeBoth])

  // ---- Exit review (Go Live) ----------------------------------------------
  const exitReview = useCallback(() => {
    // tear down review hls
    hlsRef.current?.destroy()
    hlsRef.current = null

    // revoke every blob URL we created — frees all pinned segment bytes
    blobUrlsRef.current.forEach(URL.revokeObjectURL)
    blobUrlsRef.current = []

    // drop the rolling buffer entirely — fresh start when live resumes
    rollingBufferRef.current = []
    setLiveSegments([])
    setReviewSegs([])
    setSnapshot(null)
    segEndRef.current = null

    initLive()
  }, [initLive])

  // ---- Mount ---------------------------------------------------------------
  useEffect(() => {
    if (!Hls.isSupported()) {
      setStatus('error')
      setErrorMsg('hls.js not supported in this browser')
      return
    }

    initLive()
    rafRef.current = requestAnimationFrame(tick)

    const video = videoRef.current
    const onTimeUpdate = () => {
      if (segEndRef.current !== null && video.currentTime >= segEndRef.current) {
        video.pause()
        segEndRef.current = null
      }
    }
    video?.addEventListener('timeupdate', onTimeUpdate)

    return () => {
      cancelAnimationFrame(rafRef.current)
      video?.removeEventListener('timeupdate', onTimeUpdate)
      hlsRef.current?.destroy()
      blobUrlsRef.current.forEach(URL.revokeObjectURL)
      blobUrlsRef.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Controls ------------------------------------------------------------
  const openSegList = useCallback(() => {
    if (modeRef.current === 'live') {
      // freeze the live snapshot for display, then swap to review
      setSnapshot({
        segments:    liveSegments,
        liveEdge,
        bufferStart,
        bufferedEnd,
      })
      const ok = enterReview()
      if (!ok) {
        // nothing to review yet — just pause and show empty list
        videoRef.current?.pause()
      }
    }
    setShowSegList(true)
  }, [liveSegments, liveEdge, bufferStart, bufferedEnd, enterReview])

  const closeSegList = useCallback(() => {
    setShowSegList(false)
  }, [])

  // Play one segment, auto-pause at its end. Works in either mode.
  const handlePlaySegment = useCallback((seg) => {
    const video = videoRef.current
    if (!video) return

    segEndRef.current = seg.end
    video.currentTime = seg.start
    video.play().catch(() => {})
  }, [])

  // Go Live — wipe everything and rejoin live from scratch.
  const handleGoLive = useCallback(() => {
    setShowSegList(false)

    if (modeRef.current === 'review') {
      exitReview()
      return
    }

    // already live — seek to latest fragment
    const video = videoRef.current
    const hls   = hlsRef.current
    if (!video || !hls) return
    const details  = hls.levels?.[hls.currentLevel]?.details
    const lastFrag = details?.fragments?.[details.fragments.length - 1]
    if (lastFrag) {
      video.currentTime = lastFrag.start
    } else if (Number.isFinite(hls.liveSyncPosition)) {
      video.currentTime = hls.liveSyncPosition
    }
    video.play().catch(() => {})
  }, [exitReview])

  const handleSeek = useCallback((time) => {
    const video = videoRef.current
    if (video) video.currentTime = time
  }, [])

  // ---- Display values ------------------------------------------------------
  // In review mode, show the DVR-local timeline.
  // In live mode (paused), show the snapshot.
  // In live mode (playing), show the live values.
  const inReview = mode === 'review'

  const reviewStart = inReview && reviewSegs.length > 0 ? reviewSegs[0].start : null
  const reviewEnd   = inReview && reviewSegs.length > 0 ? reviewSegs[reviewSegs.length - 1].end : null

  const displaySegments    = inReview ? reviewSegs
                              : (snapshot?.segments    ?? liveSegments)
  const displayLiveEdge    = inReview ? reviewEnd
                              : (snapshot?.liveEdge    ?? liveEdge)
  const displayBufferStart = inReview ? reviewStart
                              : (snapshot?.bufferStart ?? bufferStart)
  const displayBufferedEnd = inReview ? reviewEnd
                              : (snapshot?.bufferedEnd ?? bufferedEnd)

  // memory readout
  const memoryMB = inReview
    ? blobUrlsRef.current.length > 0
      ? Math.round(reviewSegs.reduce((acc, _, i) => acc + 6, 0)) // ~6MB/segment estimate
      : 0
    : Math.round(rollingBufferRef.current
        .reduce((acc, s) => acc + s.bytes.byteLength, 0) / (1024 * 1024))

  // ---- Hover ---------------------------------------------------------------
  const onMouseEnter = () => { clearTimeout(hoverTimer.current); setShowControls(true) }
  const onMouseLeave = () => { hoverTimer.current = setTimeout(() => setShowControls(false), 2000) }
  const onMouseMove  = () => {
    clearTimeout(hoverTimer.current)
    setShowControls(true)
    hoverTimer.current = setTimeout(() => setShowControls(false), 2500)
  }

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseMove={onMouseMove}
      style={{
        position: 'relative', width: '100%', height: '100%',
        background: '#000', display: 'flex',
        alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
      }}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
      />

      {/* connecting overlay */}
      {status === 'connecting' && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: '16px',
          background: 'rgba(8,8,8,0.92)',
        }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            {[0, 1, 2].map(i => (
              <div key={i} style={{
                width: '6px', height: '6px', borderRadius: '50%',
                background: 'var(--amber)',
                animation: `blink 1.2s ${i * 0.2}s ease-in-out infinite`,
                opacity: 0.3,
              }} />
            ))}
          </div>
          <span style={{
            fontFamily: 'var(--condensed)', letterSpacing: '0.2em',
            fontSize: '12px', color: 'var(--muted)', textTransform: 'uppercase',
          }}>
            Connecting to stream
          </span>
          <style>{`
            @keyframes blink {
              0%, 100% { opacity: 0.2; transform: scale(0.8); }
              50%       { opacity: 1;   transform: scale(1.2); }
            }
          `}</style>
        </div>
      )}

      {/* error overlay */}
      {status === 'error' && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: '12px',
          background: 'rgba(8,8,8,0.95)',
        }}>
          <span style={{ fontSize: '24px', color: 'var(--red)', opacity: 0.7 }}>✕</span>
          <span style={{
            fontFamily: 'var(--condensed)', fontSize: '13px',
            letterSpacing: '0.15em', color: 'var(--red)', textTransform: 'uppercase',
          }}>Stream Error</span>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: '11px',
            color: 'var(--muted)', maxWidth: '360px', textAlign: 'center',
          }}>
            {errorMsg ?? 'Could not connect. Is the stream server running?'}
          </span>
        </div>
      )}

      {/* mode badge */}
      {inReview && (
        <div style={{
          position: 'absolute', top: '16px', left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.75)',
          border: '1px solid rgba(245,166,35,0.4)',
          borderRadius: '4px',
          padding: '5px 14px',
          fontFamily: 'var(--condensed)',
          fontSize: '11px',
          letterSpacing: '0.2em',
          color: 'var(--amber)',
          textTransform: 'uppercase',
          pointerEvents: 'none',
        }}>
          ◉ Replay · {reviewSegs.length} segments pinned
        </div>
      )}

      {/* segment list */}
      {showSegList && status === 'playing' && (
        <SegmentList
          segments={displaySegments}
          currentTime={currentTime}
          liveEdge={displayLiveEdge}
          onPlaySegment={handlePlaySegment}
          onGoLive={handleGoLive}
          onClose={closeSegList}
        />
      )}

      {/* controls overlay */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        padding: '32px 20px 18px',
        background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%)',
        opacity: showControls ? 1 : 0,
        transition: 'opacity 0.3s ease',
        pointerEvents: showControls ? 'auto' : 'none',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', marginBottom: '10px',
        }}>
          <LiveBadge isLive={isLive && !isPaused} onClick={handleGoLive} />

          <div style={{
            display: 'flex', gap: '18px',
            fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--muted)',
          }}>
            <span>
              buf&nbsp;
              <span style={{ color: 'var(--amber)' }}>
                {inReview ? reviewSegs.length : liveSegments.length} / {REVIEW_BUFFER_SIZE}
              </span>
            </span>
            <span>
              mem&nbsp;
              <span style={{ color: 'var(--amber)' }}>{memoryMB} MB</span>
            </span>
          </div>
        </div>

        {status === 'playing' && (
          <SeekBar
            currentTime={currentTime}
            liveEdge={displayLiveEdge}
            bufferStart={displayBufferStart}
            bufferedEnd={displayBufferedEnd}
            segments={displaySegments}
            onSeek={handleSeek}
          />
        )}
      </div>

      {/* segment list toggle */}
      {status === 'playing' && (
        <button
          onClick={showSegList ? closeSegList : openSegList}
          title={showSegList ? 'Close segment list' : 'Review last segments'}
          style={{
            position: 'absolute', bottom: '16px', right: '16px',
            width: '34px', height: '34px', borderRadius: '5px',
            background: showSegList ? 'var(--amber)' : 'rgba(255,255,255,0.08)',
            border: `1px solid ${showSegList ? 'var(--amber)' : 'rgba(255,255,255,0.12)'}`,
            cursor: 'pointer', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.15s ease', zIndex: 30,
          }}
        >
          <svg width="14" height="12" viewBox="0 0 14 12" fill="none">
            {[0, 5, 10].map(y => (
              <rect key={y} x="0" y={y} width="14" height="2" rx="1"
                fill={showSegList ? '#000' : 'rgba(255,255,255,0.7)'} />
            ))}
          </svg>
        </button>
      )}
    </div>
  )
}
