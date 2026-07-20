import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react'

const backendUrl = typeof window !== 'undefined'
  ? `${window.location.protocol}//${window.location.hostname}:8000`
  : 'http://localhost:8000'

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
    if (e.name !== 'AbortError') console.warn('[EventPanel] play failed', e)
    return false
  }
}

function pauseAndReset(video) {
  if (!video) return
  video.pause()
  try {
    video.currentTime = 0
  } catch (_) { /* ignore */ }
}

/** bounce_{bounce_frame}_{csv_row}.mp4 — csv_row is zero-padded to 5 digits. */
function bounceClipName(event) {
  if (!event) return null
  const bounceFrame = event.bounce_frame ?? event.metadata?.bounce_frame
  if (bounceFrame == null || bounceFrame === '') return null
  const csvRow = event.csv_row ?? event.metadata?.csv_row
  if (csvRow == null || csvRow === '') return null
  const rowStr = String(csvRow).padStart(5, '0')
  return `bounce_${bounceFrame}_${rowStr}.mp4`
}

export default function EventPanel({ event, events = [], activeCam, onNavigate, onClose, onTracknetRefresh, graphicsReady = false }) {
  const v1 = useRef(null)
  const v2 = useRef(null)
  const v3 = useRef(null)
  const playGenRef = useRef(0)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(2)
  const [retryCounts, setRetryCounts] = useState({ source: 0, sink: 0, hq: 0 })
  const [clipStatus, setClipStatus] = useState({ source: 'idle', sink: 'idle', hq: 'idle' })

  const [analyzing, setAnalyzing] = useState(false)
  const [analyzingCams, setAnalyzingCams] = useState({ source: false, sink: false, hq: false })
  const [analyzeError, setAnalyzeError] = useState(null)
  const [trajectoryClipNames, setTrajectoryClipNames] = useState({})
  const [showGraphics, setShowGraphics] = useState(false)

  const cameras = useMemo(() => [
    { id: 'source', label: 'Cam 1 - SOURCE', ref: v1 },
    { id: 'sink',   label: 'Cam 2 - SINK',   ref: v2 },
    { id: 'hq',     label: 'Cam 3 - HQ',     ref: v3 },
  ], [])

  const clipBaseName = useMemo(() => bounceClipName(event), [event])

  const pauseAll = useCallback(() => {
    playGenRef.current += 1
    cameras.forEach(c => pauseAndReset(c.ref.current))
    setPlaying(false)
  }, [cameras])

  const handlePlayPause = async () => {
    if (!clipBaseName && Object.keys(trajectoryClipNames).length === 0) return
    const gen = ++playGenRef.current
    const wantPlay = !playing

    if (!wantPlay) {
      pauseAll()
      return
    }

    setPlaying(true)
    for (const c of cameras) {
      if (playGenRef.current !== gen) return
      const v = c.ref.current
      if (!v || clipStatus[c.id] !== 'ready') continue
      const ok = await safePlay(v)
      if (playGenRef.current !== gen) return
      if (!ok) {
        setPlaying(false)
        return
      }
    }
  }

  const currentIndex = events.findIndex(ev => ev.id === event?.id)
  const handlePrev = () => {
    if (currentIndex > 0 && onNavigate) onNavigate(events[currentIndex - 1])
  }
  const handleNext = () => {
    if (currentIndex < events.length - 1 && onNavigate) onNavigate(events[currentIndex + 1])
  }

  const seekAll = useCallback((time) => {
    setProgress(time)
    cameras.forEach(c => {
      if (c.ref.current) c.ref.current.currentTime = time
    })
  }, [cameras])

  const handleSeek = (e) => {
    seekAll(parseFloat(e.target.value))
  }

  const handleAnalyze = async () => {
    if (!event) return
    // run_graphics.sh is keyed on csv_row (0-based flight_shots.csv data row).
    const csvRow = event.csv_row ?? event.metadata?.csv_row
    if (csvRow == null) {
      setAnalyzeError('No csv_row on this event — cannot run graphics.')
      return
    }

    pauseAll()
    setAnalyzing(true)
    setAnalyzeError(null)
    setTrajectoryClipNames({})

    // Keep the header TrackNet pill in sync in real time: it flips to OFF while the
    // backend frees TrackNet for this analysis, then back to AUTO once the clip returns.
    onTracknetRefresh?.()
    const trackPoll = setInterval(() => onTracknetRefresh?.(), 2500)

    try {
      // Main button: no `cameras` -> backend runs run_graphics.sh without --camera (all cams).
      // If TrackNet is still on, the server runs load_graphics first then continues.
      const res = await fetch(`${backendUrl}/analyze_bounce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv_row: Number(csvRow) }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }

      const data = await res.json()
      setTrajectoryClipNames(data.clip_names || {})
    } catch (e) {
      console.error('[analyze]', e)
      setAnalyzeError(e.message || 'Analysis failed')
    } finally {
      setAnalyzing(false)
      clearInterval(trackPoll)
      onTracknetRefresh?.()
    }
  }

  const handleAnalyzeCam = async (camId) => {
    if (!event) return
    const csvRow = event.csv_row ?? event.metadata?.csv_row
    if (csvRow == null) {
      setAnalyzeError('No csv_row on this event — cannot run graphics.')
      return
    }
    pauseAll()
    setAnalyzingCams(prev => ({ ...prev, [camId]: true }))
    setAnalyzeError(null)

    // Mirror the header TrackNet pill state while this per-camera analysis runs.
    onTracknetRefresh?.()
    const trackPoll = setInterval(() => onTracknetRefresh?.(), 2500)

    try {
      // Per-camera button: pass `cameras` -> backend adds --camera <cam> to run_graphics.sh.
      // If TrackNet is still on, the server runs load_graphics first then continues.
      const res = await fetch(`${backendUrl}/analyze_bounce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csv_row: Number(csvRow),
          cameras: [camId],
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setTrajectoryClipNames(prev => ({ ...prev, ...(data.clip_names || {}) }))
    } catch (e) {
      console.error('[analyze cam]', e)
      setAnalyzeError(e.message || 'Analysis failed')
    } finally {
      setAnalyzingCams(prev => ({ ...prev, [camId]: false }))
      clearInterval(trackPoll)
      onTracknetRefresh?.()
    }
  }

  useEffect(() => {
    pauseAll()
    setProgress(0)
    setDuration(2)
    setTrajectoryClipNames({})
    setAnalyzeError(null)
    setShowGraphics(false)
    setAnalyzingCams({ source: false, sink: false, hq: false })
    setRetryCounts({ source: 0, sink: 0, hq: 0 })
    setClipStatus({ source: 'idle', sink: 'idle', hq: 'idle' })

    // Restore any previously-analysed graphics clips for this bounce so navigating
    // back doesn't require a re-analyse. The server keeps the downloaded files around.
    const bf = event?.bounce_frame ?? event?.metadata?.bounce_frame
    if (bf == null) return
    let cancelled = false
    fetch(`${backendUrl}/trajectory_clips?bounce_frame=${bf}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (cancelled || !d?.clip_names) return
        if (Object.keys(d.clip_names).length > 0) setTrajectoryClipNames(d.clip_names)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [event, pauseAll])

  if (!event) return null

  const missingClipMeta = !clipBaseName

  return (
    <div style={{
      width: '100%', height: '100%',
      background: '#0a0a0a', padding: '16px 32px',
      display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
    }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          {clipBaseName
            ? (
              <span style={{ color: '#e8e8e8', fontWeight: 'bold', fontSize: '15px', fontFamily: 'monospace' }}>
                {clipBaseName}
              </span>
            )
            : (
              <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '13px', fontFamily: 'monospace' }}>
                No clip file
              </span>
            )
          }
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {/* Graphic / Bounce toggle — only clickable once at least one trajectory clip exists */}
          <button
            onClick={() => setShowGraphics(v => !v)}
            disabled={Object.keys(trajectoryClipNames).length === 0}
            title={showGraphics ? 'Switch to Bounce Clip' : 'Switch to Graphic Clip'}
            style={{
              background: showGraphics
                ? 'linear-gradient(135deg, #50e3c2, #2aa98a)'
                : 'rgba(255,255,255,0.1)',
              color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '6px',
              cursor: Object.keys(trajectoryClipNames).length === 0 ? 'not-allowed' : 'pointer',
              opacity: Object.keys(trajectoryClipNames).length === 0 ? 0.35 : 1,
              fontWeight: 'bold', fontSize: '12px', letterSpacing: '0.05em',
              transition: 'background 0.25s, opacity 0.25s',
            }}
          >
            {showGraphics ? 'GRAPHIC' : 'BOUNCE'}
          </button>
          <button
            onClick={handleAnalyze}
            disabled={analyzing}
            title={graphicsReady
              ? 'Run TrackNet trajectory analysis on Jetson (all cameras)'
              : 'TrackNet still on — analyse will run load_graphics first, then continue'}
            style={{
              background: analyzing
                ? '#444'
                : Object.keys(trajectoryClipNames).length > 0
                  ? 'linear-gradient(135deg, #50e3c2, #2aa98a)'
                  : 'linear-gradient(135deg, #e74c3c, #c0392b)',
              color: '#fff', border: 'none', padding: '8px 20px', borderRadius: '6px',
              cursor: analyzing ? 'wait' : 'pointer', fontWeight: 'bold', fontSize: '12px',
              letterSpacing: '0.05em', transition: 'background 0.3s',
            }}
          >
            {analyzing ? 'ANALYSING…' : Object.keys(trajectoryClipNames).length > 0 ? 'RE-ANALYSE ALL' : 'ANALYSE ALL'}
          </button>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '20px' }}>✕</button>
        </div>
      </div>

      {analyzing && (
        <div style={{ color: '#f39c12', fontSize: '12px', marginBottom: '8px', fontFamily: 'monospace' }}>
          ⏳ Running graphics on Jetson… if TrackNet is on, load_graphics runs first.
        </div>
      )}
      {!graphicsReady && !analyzing && (
        <div style={{ color: '#f39c12', fontSize: '12px', marginBottom: '8px', fontFamily: 'monospace' }}>
          ⏳ TrackNet not off yet — Analyse will turn it off via load_graphics, then run.
        </div>
      )}
      {analyzeError && (
        <div style={{ color: '#ff6b6b', fontSize: '12px', marginBottom: '8px' }}>{analyzeError}</div>
      )}
      {missingClipMeta && (
        <div style={{ color: '#ff6b6b', fontSize: '12px', marginBottom: '8px' }}>
          Missing bounce_frame or csv_row — cannot build clip URL.
        </div>
      )}

      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flex: 1, minHeight: 0 }}>
        {cameras.map(cam => {
          const retryCount = retryCounts[cam.id] || 0
          const status = clipStatus[cam.id] || 'idle'
          const camTrajectoryClip = trajectoryClipNames[cam.id] ?? null
          const showTrajectory = showGraphics && camTrajectoryClip != null

          const clipUrl = missingClipMeta
            ? null
            : showTrajectory
              ? `${backendUrl}/trajectory_clip/${camTrajectoryClip}`
              : `${backendUrl}/clips/${cam.id}/${clipBaseName}${retryCount > 0 ? `?retry=${retryCount}` : ''}`

          const handleError = () => {
            pauseAndReset(cam.ref.current)
            if (!showTrajectory && retryCount < 5) {
              setClipStatus(prev => ({ ...prev, [cam.id]: 'loading' }))
              setTimeout(() => {
                setRetryCounts(prev => ({ ...prev, [cam.id]: (prev[cam.id] || 0) + 1 }))
              }, 1500)
            } else if (!showTrajectory) {
              setClipStatus(prev => ({ ...prev, [cam.id]: 'error' }))
              console.warn(`[EventPanel] Failed to load ${cam.id}: ${clipUrl}`)
            }
          }

          return (
            <div key={`${cam.id}-${clipUrl ?? 'none'}-${retryCount}`} style={{ flex: 1, background: '#000', borderRadius: '8px', overflow: 'hidden', position: 'relative' }}>
              <div style={{ position: 'absolute', top: 8, left: 8, right: 8, background: 'rgba(0,0,0,0.6)', padding: '4px 8px', fontSize: '12px', color: '#fff', borderRadius: '4px', zIndex: 2, display: 'flex', alignItems: 'center', gap: '6px' }}>
                {cam.label}
                {showTrajectory && (
                  <span style={{ color: '#50e3c2', fontWeight: 'bold' }}>· TRAJECTORY</span>
                )}
                {status === 'loading' && (
                  <span style={{ color: '#f39c12' }}>(loading…)</span>
                )}
                {!showTrajectory && retryCount > 0 && retryCount < 5 && status === 'loading' && (
                  <span style={{ color: '#f39c12' }}>retry {retryCount}/5</span>
                )}
                {status === 'error' && (
                  <span style={{ color: '#e74c3c' }}>(failed)</span>
                )}
                <button
                  onClick={() => handleAnalyzeCam(cam.id)}
                  disabled={analyzingCams[cam.id] || analyzing}
                  title={graphicsReady
                    ? `Run TrackNet analysis for ${cam.label} only`
                    : 'TrackNet still on — analyse will run load_graphics first, then continue'}
                  style={{
                    marginLeft: 'auto',
                    background: analyzingCams[cam.id]
                      ? '#555'
                      : trajectoryClipNames[cam.id]
                        ? 'rgba(80,227,194,0.25)'
                        : 'rgba(231,76,60,0.75)',
                    color: '#fff', border: 'none', padding: '2px 8px', borderRadius: '4px',
                    cursor: (analyzingCams[cam.id] || analyzing) ? 'wait' : 'pointer',
                    fontSize: '10px', fontWeight: 'bold', letterSpacing: '0.04em',
                    opacity: analyzing ? 0.5 : 1,
                    transition: 'background 0.2s',
                    flexShrink: 0,
                  }}
                >
                  {analyzingCams[cam.id] ? '…' : trajectoryClipNames[cam.id] ? 'RE-ANALYSE' : 'ANALYSE'}
                </button>
              </div>

              {(status === 'loading' || status === 'idle') && clipUrl && (
                <div style={{
                  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'rgba(255,255,255,0.5)', fontSize: '13px', zIndex: 1, pointerEvents: 'none',
                }}>
                  {status === 'idle' ? 'Preparing…' : 'Fetching clip from server…'}
                </div>
              )}

              {status === 'error' && (
                <div style={{
                  position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', padding: '16px', textAlign: 'center',
                  color: '#e74c3c', fontSize: '12px', zIndex: 1,
                }}>
                  <div>Clip not available</div>
                  <div style={{ color: 'rgba(255,255,255,0.35)', marginTop: 8, fontFamily: 'monospace', fontSize: '10px', wordBreak: 'break-all' }}>
                    {clipUrl}
                  </div>
                </div>
              )}

              {clipUrl && (
                <video
                  ref={cam.ref}
                  key={clipUrl}
                  src={clipUrl}
                  crossOrigin="anonymous"
                  muted
                  playsInline
                  preload="auto"
                  onLoadStart={() => {
                    setClipStatus(prev => ({ ...prev, [cam.id]: 'loading' }))
                  }}
                  onError={handleError}
                  onCanPlay={() => {
                    setClipStatus(prev => ({ ...prev, [cam.id]: 'ready' }))
                  }}
                  onTimeUpdate={(e) => {
                    if (cam.id === 'hq') {
                      setProgress(e.target.currentTime)
                      if (e.target.duration && e.target.currentTime >= e.target.duration - 0.05) {
                        setPlaying(false)
                      }
                    }
                  }}
                  onLoadedMetadata={(e) => {
                    if (cam.id === 'hq') setDuration(e.target.duration || 2)
                  }}
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
              )}
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', position: 'relative' }}>
        <button onClick={handlePrev} disabled={currentIndex <= 0} style={{
          background: 'rgba(255,255,255,0.1)', color: currentIndex <= 0 ? 'rgba(255,255,255,0.2)' : '#fff', border: 'none',
          padding: '8px 16px', borderRadius: '6px', cursor: currentIndex <= 0 ? 'default' : 'pointer', fontWeight: 'bold', fontSize: '12px',
        }}>
          ◀ PREV EVENT
        </button>
        <button
          onClick={handlePlayPause}
          disabled={missingClipMeta || !Object.values(clipStatus).some(s => s === 'ready')}
          style={{
            background: 'linear-gradient(135deg, #e8e8e8, #c0c0c0)', color: '#000', border: 'none',
            width: '40px', height: '40px', borderRadius: '50%',
            cursor: missingClipMeta ? 'not-allowed' : 'pointer',
            opacity: missingClipMeta ? 0.4 : 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px',
          }}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button onClick={handleNext} disabled={currentIndex >= events.length - 1 || currentIndex === -1} style={{
          background: 'rgba(255,255,255,0.1)', color: (currentIndex >= events.length - 1 || currentIndex === -1) ? 'rgba(255,255,255,0.2)' : '#fff', border: 'none',
          padding: '8px 16px', borderRadius: '6px', cursor: (currentIndex >= events.length - 1 || currentIndex === -1) ? 'default' : 'pointer', fontWeight: 'bold', fontSize: '12px',
        }}>
          NEXT EVENT ▶
        </button>
        <div style={{ flex: 1, position: 'relative' }}>
          <input
            type="range"
            min="0"
            max={duration}
            step="0.01"
            value={progress}
            onChange={handleSeek}
            style={{ width: '100%', cursor: 'pointer' }}
          />
        </div>
      </div>
    </div>
  )
}
