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

  const [camWidths, setCamWidths] = useState([33.33, 33.33, 33.34])
  const [resizingColIndex, setResizingColIndex] = useState(null)
  const cardsContainerRef = useRef(null)

  const handleColResizeStart = useCallback((colIndex, e) => {
    e.preventDefault()
    setResizingColIndex(colIndex)
    const startX = e.clientX
    const startWidths = [...camWidths]
    const containerW = cardsContainerRef.current ? cardsContainerRef.current.clientWidth : 1000

    const onMouseMove = (moveEv) => {
      const deltaX = moveEv.clientX - startX
      const deltaPercent = (deltaX / containerW) * 100

      if (colIndex === 0) {
        let w0 = startWidths[0] + deltaPercent
        let w1 = startWidths[1] - deltaPercent
        if (w0 < 15) {
          w0 = 15
          w1 = startWidths[0] + startWidths[1] - 15
        }
        if (w1 < 15) {
          w1 = 15
          w0 = startWidths[0] + startWidths[1] - 15
        }
        setCamWidths([w0, w1, startWidths[2]])
      } else if (colIndex === 1) {
        let w1 = startWidths[1] + deltaPercent
        let w2 = startWidths[2] - deltaPercent
        if (w1 < 15) {
          w1 = 15
          w2 = startWidths[1] + startWidths[2] - 15
        }
        if (w2 < 15) {
          w2 = 15
          w1 = startWidths[1] + startWidths[2] - 15
        }
        setCamWidths([startWidths[0], w1, w2])
      }
    }

    const onMouseUp = () => {
      setResizingColIndex(null)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [camWidths])

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
      background: 'rgba(10, 10, 14, 0.98)', padding: '6px 12px 10px',
      display: 'flex', flexDirection: 'column', boxSizing: 'border-box', position: 'relative',
    }}>

      {/* Floating Top Controls Overlay Pill */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '6px', zIndex: 10, padding: '2px 4px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button onClick={handlePrev} disabled={currentIndex <= 0} style={{
            background: 'rgba(255,255,255,0.1)', color: currentIndex <= 0 ? 'rgba(255,255,255,0.2)' : '#fff',
            border: '1px solid rgba(255,255,255,0.15)',
            padding: '3px 10px', borderRadius: '12px', cursor: currentIndex <= 0 ? 'default' : 'pointer',
            fontWeight: '700', fontSize: '10px', transition: 'all 0.2s ease', backdropFilter: 'blur(8px)'
          }}>
            ◀ PREV
          </button>

          {clipBaseName
            ? (
              <span style={{ color: '#fff', fontWeight: '800', fontSize: '11px', fontFamily: 'monospace', letterSpacing: '0.05em', background: 'rgba(255,255,255,0.1)', padding: '3px 10px', borderRadius: '12px', backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.12)' }}>
                {clipBaseName}
              </span>
            )
            : (
              <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '11px', fontFamily: 'monospace' }}>
                No clip file
              </span>
            )
          }

          <button onClick={handleNext} disabled={currentIndex >= events.length - 1 || currentIndex === -1} style={{
            background: 'rgba(255,255,255,0.1)', color: (currentIndex >= events.length - 1 || currentIndex === -1) ? 'rgba(255,255,255,0.2)' : '#fff',
            border: '1px solid rgba(255,255,255,0.15)',
            padding: '3px 10px', borderRadius: '12px', cursor: (currentIndex >= events.length - 1 || currentIndex === -1) ? 'default' : 'pointer',
            fontWeight: '700', fontSize: '10px', transition: 'all 0.2s ease', backdropFilter: 'blur(8px)'
          }}>
            NEXT ▶
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            onClick={() => setShowGraphics(v => !v)}
            disabled={Object.keys(trajectoryClipNames).length === 0}
            title={showGraphics ? 'Switch to Bounce Clip' : 'Switch to Graphic Clip'}
            style={{
              background: showGraphics ? 'linear-gradient(135deg, #10b981, #059669)' : 'rgba(255,255,255,0.12)',
              color: '#fff', border: '1px solid rgba(255,255,255,0.15)', padding: '3px 12px', borderRadius: '14px',
              cursor: Object.keys(trajectoryClipNames).length === 0 ? 'not-allowed' : 'pointer',
              opacity: Object.keys(trajectoryClipNames).length === 0 ? 0.35 : 1,
              fontWeight: '700', fontSize: '10px', letterSpacing: '0.05em',
              transition: 'all 0.2s ease', backdropFilter: 'blur(10px)'
            }}
          >
            {showGraphics ? 'GRAPHIC' : 'BOUNCE'}
          </button>
          <button
            onClick={handleAnalyze}
            disabled={analyzing}
            title="Run TrackNet trajectory analysis for all cameras"
            style={{
              background: analyzing
                ? '#444'
                : Object.keys(trajectoryClipNames).length > 0
                  ? 'linear-gradient(135deg, #10b981, #059669)'
                  : 'linear-gradient(135deg, #ef4444, #dc2626)',
              color: '#fff', border: 'none', padding: '3px 14px', borderRadius: '14px',
              cursor: analyzing ? 'wait' : 'pointer', fontWeight: '700', fontSize: '10px',
              letterSpacing: '0.05em', transition: 'all 0.2s ease',
              boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            }}
          >
            {analyzing ? 'ANALYSING…' : Object.keys(trajectoryClipNames).length > 0 ? 'RE-ANALYSE ALL' : 'ANALYSE ALL'}
          </button>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.12)', border: 'none', color: '#fff', cursor: 'pointer', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px' }}>✕</button>
        </div>
      </div>

      {analyzeError && (
        <div style={{ color: '#ff6b6b', fontSize: '10px', marginBottom: '4px' }}>{analyzeError}</div>
      )}

      {/* 3 Bounce Clip Cards Container */}
      <div ref={cardsContainerRef} style={{ display: 'flex', gap: '2px', marginBottom: '6px', flex: 1, minHeight: 0, position: 'relative' }}>
        {cameras.map((cam, idx) => {
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
            <React.Fragment key={`${cam.id}-${clipUrl ?? 'none'}-${retryCount}`}>
              {idx > 0 && (
                <div
                  onMouseDown={(e) => handleColResizeStart(idx - 1, e)}
                  title="Drag left/right to resize camera clip cards"
                  style={{
                    width: '8px', cursor: 'col-resize',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    zIndex: 10, userSelect: 'none', flexShrink: 0,
                    background: resizingColIndex === idx - 1 ? 'rgba(59, 130, 246, 0.4)' : 'transparent',
                    transition: 'background 0.2s ease'
                  }}
                >
                  <div style={{ width: '2.5px', height: '36px', background: resizingColIndex === idx - 1 ? '#60a5fa' : 'rgba(255, 255, 255, 0.25)', borderRadius: '1.5px' }} />
                </div>
              )}
              <div style={{
                width: `calc(${camWidths[idx]}% - ${idx > 0 && idx < 2 ? '12px' : '6px'})`,
                background: '#000', borderRadius: '10px', overflow: 'hidden', position: 'relative',
                border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, transition: resizingColIndex !== null ? 'none' : 'width 0.2s ease'
              }}>
                {/* Standalone Top-Left Camera Title Badge */}
                <div style={{
                  position: 'absolute', top: 8, left: 8,
                  background: 'rgba(15, 15, 22, 0.65)',
                  backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
                  padding: '3px 8px', fontSize: '10px', color: '#fff', borderRadius: '12px',
                  border: '1px solid rgba(255,255,255,0.12)', zIndex: 4, display: 'flex', alignItems: 'center', gap: '4px'
                }}>
                  <span style={{ fontWeight: '700' }}>{cam.label}</span>
                  {showTrajectory && (
                    <span style={{ color: '#10b981', fontWeight: 'bold', fontSize: '9px' }}>· TRAJECTORY</span>
                  )}
                  {status === 'loading' && (
                    <span style={{ color: '#f59e0b', fontSize: '9px' }}>(loading…)</span>
                  )}
                </div>

                {/* Standalone Top-Right Analyze Button */}
                <button
                  onClick={() => handleAnalyzeCam(cam.id)}
                  disabled={analyzingCams[cam.id] || analyzing}
                  title={`Run analysis for ${cam.label}`}
                  style={{
                    position: 'absolute', top: 8, right: 8, zIndex: 4,
                    background: analyzingCams[cam.id]
                      ? '#555'
                      : trajectoryClipNames[cam.id]
                        ? 'rgba(16, 185, 129, 0.4)'
                        : 'rgba(239, 68, 68, 0.85)',
                    color: '#fff', border: '1px solid rgba(255,255,255,0.2)', padding: '3px 10px', borderRadius: '12px',
                    cursor: (analyzingCams[cam.id] || analyzing) ? 'wait' : 'pointer',
                    fontSize: '9px', fontWeight: 'bold', letterSpacing: '0.04em',
                    opacity: analyzing ? 0.5 : 1, transition: 'all 0.2s', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                    backdropFilter: 'blur(10px)'
                  }}
                >
                  {analyzingCams[cam.id] ? '…' : trajectoryClipNames[cam.id] ? 'RE-ANALYSE' : 'ANALYSE'}
                </button>

                {(status === 'loading' || status === 'idle') && clipUrl && (
                  <div style={{
                    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'rgba(255,255,255,0.4)', fontSize: '11px', zIndex: 1, pointerEvents: 'none',
                  }}>
                    {status === 'idle' ? 'Preparing…' : 'Fetching clip…'}
                  </div>
                )}

                {status === 'error' && (
                  <div style={{
                    position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center', gap: '8px', zIndex: 2,
                    background: 'rgba(10,10,14,0.95)', color: '#ef4444', fontSize: '11px', textAlign: 'center', padding: '12px'
                  }}>
                    <span>Failed to load video</span>
                    <button
                      onClick={() => {
                        setClipStatus(prev => ({ ...prev, [cam.id]: 'loading' }))
                        setRetryCounts(prev => ({ ...prev, [cam.id]: (prev[cam.id] || 0) + 1 }))
                      }}
                      style={{
                        background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)',
                        color: '#fff', padding: '3px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '10px'
                      }}
                    >
                      Retry
                    </button>
                  </div>
                )}

                {missingClipMeta && (
                  <div style={{
                    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'rgba(255,255,255,0.3)', fontSize: '11px', zIndex: 2,
                  }}>
                    No clip metadata available
                  </div>
                )}

                {clipUrl && (
                  <video
                    ref={cam.ref}
                    src={clipUrl}
                    playsInline
                    muted
                    preload="auto"
                    onCanPlay={() => { setClipStatus(prev => ({ ...prev, [cam.id]: 'ready' })) }}
                    onError={handleError}
                    onEnded={() => {
                      if (cam.ref.current) {
                        cam.ref.current.pause()
                      }
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
                    style={{ width: '100%', height: '100%', objectFit: 'contain', zIndex: 0 }}
                  />
                )}

                {/* Overlaid Individual Per-Clip Floating Glass Control Bar */}
                <div style={{
                  position: 'absolute', bottom: 6, left: 6, right: 6, zIndex: 10,
                  background: 'rgba(15, 15, 22, 0.75)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                  borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)', padding: '3px 8px',
                  display: 'flex', alignItems: 'center', gap: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.4)'
                }}>
                  <button
                    onClick={() => {
                      if (cam.ref.current) {
                        cam.ref.current.currentTime = Math.max(0, cam.ref.current.currentTime - (1/30))
                      }
                    }}
                    style={{ background: 'rgba(255,255,255,0.12)', border: 'none', color: '#fff', borderRadius: '10px', padding: '2px 6px', fontSize: '9px', fontWeight: 'bold', cursor: 'pointer' }}
                  >
                    -1F
                  </button>
                  <button
                    onClick={() => {
                      if (cam.ref.current) {
                        if (cam.ref.current.paused) cam.ref.current.play()
                        else cam.ref.current.pause()
                      }
                    }}
                    style={{ background: '#fff', border: 'none', color: '#000', borderRadius: '50%', width: '18px', height: '18px', fontSize: '9px', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    {cam.ref.current?.paused ? '▶' : '⏸'}
                  </button>
                  <button
                    onClick={() => {
                      if (cam.ref.current) {
                        cam.ref.current.currentTime = Math.min(cam.ref.current.duration || 2, cam.ref.current.currentTime + (1/30))
                      }
                    }}
                    style={{ background: 'rgba(255,255,255,0.12)', border: 'none', color: '#fff', borderRadius: '10px', padding: '2px 6px', fontSize: '9px', fontWeight: 'bold', cursor: 'pointer' }}
                  >
                    +1F
                  </button>
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                    <input
                      type="range"
                      min="0"
                      max={cam.ref.current?.duration || 2}
                      step="0.01"
                      value={cam.ref.current?.currentTime || 0}
                      onChange={(e) => {
                        if (cam.ref.current) {
                          cam.ref.current.currentTime = parseFloat(e.target.value)
                        }
                      }}
                      style={{ width: '100%', height: '3px', cursor: 'pointer', accentColor: '#3b82f6' }}
                    />
                  </div>
                </div>
              </div>
            </React.Fragment>
          )
        })}
      </div>


    </div>
  )
}
