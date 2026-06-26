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

/** bounce_{bounce_frame}_{flight_id}.mp4 — flight_id is zero-padded to 5 digits. */
function bounceClipName(event) {
  if (!event) return null
  const bounceFrame = event.bounce_frame ?? event.metadata?.bounce_frame
  if (bounceFrame == null || bounceFrame === '') return null
  const flightId = event.metadata?.flight_id
  if (flightId == null || flightId === '') return null
  const flightIdStr = String(flightId).padStart(5, '0')
  return `bounce_${bounceFrame}_${flightIdStr}.mp4`
}

export default function EventPanel({ event, events = [], activeCam, onNavigate, onClose }) {
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
  const [analyzeError, setAnalyzeError] = useState(null)
  const [trajectoryClipName, setTrajectoryClipName] = useState(null)

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
    if (!clipBaseName && !trajectoryClipName) return
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
    const bounceNumber = event.bounce_frame ?? event.metadata?.bounce_frame
    const bounceFrame  = event.hq_frame ?? bounceNumber
    if (bounceNumber == null) {
      setAnalyzeError('No bounce_frame on this event.')
      return
    }

    pauseAll()
    setAnalyzing(true)
    setAnalyzeError(null)
    setTrajectoryClipName(null)

    try {
      const res = await fetch(`${backendUrl}/analyze_bounce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bounce_number: Number(bounceNumber), bounce_frame: Number(bounceFrame ?? bounceNumber) }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }

      const data = await res.json()
      setTrajectoryClipName(data.clip_name)
    } catch (e) {
      console.error('[analyze]', e)
      setAnalyzeError(e.message || 'Analysis failed')
    } finally {
      setAnalyzing(false)
    }
  }

  useEffect(() => {
    pauseAll()
    setProgress(0)
    setDuration(2)
    setTrajectoryClipName(null)
    setAnalyzeError(null)
    setRetryCounts({ source: 0, sink: 0, hq: 0 })
    setClipStatus({ source: 'idle', sink: 'idle', hq: 'idle' })
  }, [event, pauseAll])

  if (!event) return null

  const bounceFrame = event.bounce_frame ?? event.metadata?.bounce_frame
  const missingClipMeta = !clipBaseName

  return (
    <div style={{
      width: '100%', height: '100%',
      background: '#0a0a0a', padding: '16px 32px',
      display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
    }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <span style={{ color: '#e8e8e8', fontWeight: 'bold', fontSize: '18px' }}>Event {event.id}</span>
          <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '14px', fontFamily: 'monospace' }}>
            {activeCam.toUpperCase()} Frame: {event.frames ? event.frames[activeCam] : 'N/A'}
          </span>
          <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '12px', fontFamily: 'monospace' }}>
            (HQ Frame: {event.hq_frame}) · bounce_frame: {bounceFrame ?? 'N/A'} · flight_id: {event.metadata?.flight_id ?? 'N/A'}
          </span>
          {clipBaseName && (
            <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: '11px', fontFamily: 'monospace' }}>
              {clipBaseName}
            </span>
          )}
          {trajectoryClipName && (
            <span style={{ color: '#50e3c2', fontSize: '12px', fontFamily: 'monospace', fontWeight: 'bold' }}>
              ✓ TRAJECTORY LOADED
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            onClick={handleAnalyze}
            disabled={analyzing}
            title="Run TrackNet trajectory analysis on Jetson (HQ only)"
            style={{
              background: analyzing
                ? '#444'
                : trajectoryClipName
                  ? 'linear-gradient(135deg, #50e3c2, #2aa98a)'
                  : 'linear-gradient(135deg, #e74c3c, #c0392b)',
              color: '#fff', border: 'none', padding: '8px 20px', borderRadius: '6px',
              cursor: analyzing ? 'wait' : 'pointer', fontWeight: 'bold', fontSize: '12px',
              letterSpacing: '0.05em', transition: 'background 0.3s',
            }}
          >
            {analyzing ? 'ANALYSING…' : trajectoryClipName ? 'RE-ANALYSE' : 'ANALYSE'}
          </button>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '20px' }}>✕</button>
        </div>
      </div>

      {analyzing && (
        <div style={{ color: '#f39c12', fontSize: '12px', marginBottom: '8px', fontFamily: 'monospace' }}>
          ⏳ Running TrackNet on Jetson… this may take up to ~2 minutes.
        </div>
      )}
      {analyzeError && (
        <div style={{ color: '#ff6b6b', fontSize: '12px', marginBottom: '8px' }}>{analyzeError}</div>
      )}
      {missingClipMeta && (
        <div style={{ color: '#ff6b6b', fontSize: '12px', marginBottom: '8px' }}>
          Missing bounce_frame or flight_id — cannot build clip URL.
        </div>
      )}

      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flex: 1, minHeight: 0 }}>
        {cameras.map(cam => {
          const retryCount = retryCounts[cam.id] || 0
          const status = clipStatus[cam.id] || 'idle'
          const isHq = cam.id === 'hq'
          const showTrajectory = isHq && trajectoryClipName != null

          const clipUrl = missingClipMeta
            ? null
            : showTrajectory
              ? `${backendUrl}/trajectory_clip/${trajectoryClipName}`
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
              <div style={{ position: 'absolute', top: 8, left: 8, background: 'rgba(0,0,0,0.6)', padding: '4px 8px', fontSize: '12px', color: '#fff', borderRadius: '4px', zIndex: 2, display: 'flex', alignItems: 'center', gap: '6px' }}>
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
