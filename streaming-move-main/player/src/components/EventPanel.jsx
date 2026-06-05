import React, { useRef, useState, useEffect, useCallback } from 'react'
import BounceLandingOverlay from './BounceLandingOverlay.jsx'
import { analyzeBounceLanding } from '../utils/bounceLandingDetect.js'

const backendUrl = typeof window !== 'undefined'
  ? `${window.location.protocol}//${window.location.hostname}:8000`
  : 'http://localhost:8000'

export default function EventPanel({ event, events = [], activeCam, onNavigate, onClose }) {
  const v1 = useRef(null)
  const v2 = useRef(null)
  const v3 = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(2)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzed, setAnalyzed] = useState(false)
  const [landingByCam, setLandingByCam] = useState({ source: null, sink: null, hq: null })
  const [analyzeError, setAnalyzeError] = useState(null)

  const cameras = [
    { id: 'source', label: 'Cam 1 - SOURCE', ref: v1 },
    { id: 'sink', label: 'Cam 2 - SINK', ref: v2 },
    { id: 'hq', label: 'Cam 3 - HQ', ref: v3 },
  ]

  const handlePlayPause = () => {
    const isNowPlaying = !playing
    cameras.forEach(c => {
      if (c.ref.current) {
        if (isNowPlaying) c.ref.current.play().catch(e => console.log('play error', e))
        else c.ref.current.pause()
      }
    })
    setPlaying(isNowPlaying)
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
  }, [])

  const handleSeek = (e) => {
    seekAll(parseFloat(e.target.value))
  }

  const handleAnalyze = async () => {
    setAnalyzing(true)
    setAnalyzeError(null)
    setAnalyzed(false)
    setLandingByCam({ source: null, sink: null, hq: null })

    try {
      const results = {}
      for (const cam of cameras) {
        const video = cam.ref.current
        if (!video) continue
        results[cam.id] = await analyzeBounceLanding(video)
      }

      setLandingByCam(results)

      const times = Object.values(results).map(r => r?.timeSec).filter(t => t != null)
      const masterTime = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0

      seekAll(masterTime)
      cameras.forEach(c => c.ref.current?.pause())
      setPlaying(false)
      setAnalyzed(true)
    } catch (e) {
      console.error('[analyze]', e)
      setAnalyzeError(e.message || 'Analysis failed')
    } finally {
      setAnalyzing(false)
    }
  }

  useEffect(() => {
    setPlaying(false)
    setProgress(0)
    setAnalyzed(false)
    setLandingByCam({ source: null, sink: null, hq: null })
    setAnalyzeError(null)
  }, [event])

  if (!event) return null

  const flightIdStr = String(event.metadata.flight_id).padStart(5, '0')
  const bounceFrame = event.bounce_frame ?? event.metadata.bounce_frame
  const masterLanding = landingByCam.hq || landingByCam.sink || landingByCam.source
  const landingMarkerPct = masterLanding && duration > 0
    ? (masterLanding.timeSec / duration) * 100
    : null

  return (
    <div style={{
      width: '100%', height: '100%',
      background: '#0a0a0a', padding: '16px 32px',
      display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
    }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--amber, #f5a623)', fontWeight: 'bold', fontSize: '18px' }}>Event {event.id}</span>
          <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '14px', fontFamily: 'monospace' }}>
            {activeCam.toUpperCase()} Frame: {event.frames ? event.frames[activeCam] : 'N/A'}
          </span>
          <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '12px', fontFamily: 'monospace' }}>
            (HQ Frame: {event.hq_frame})
          </span>
          {analyzed && masterLanding && (
            <span style={{ color: '#ff6b6b', fontSize: '12px', fontFamily: 'monospace' }}>
              Landing @ {masterLanding.timeSec.toFixed(2)}s (f{masterLanding.frameIndex}, {masterLanding.method})
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            onClick={handleAnalyze}
            disabled={analyzing}
            style={{
              background: analyzing ? '#444' : 'linear-gradient(135deg, #e74c3c, #c0392b)',
              color: '#fff', border: 'none', padding: '8px 20px', borderRadius: '6px',
              cursor: analyzing ? 'wait' : 'pointer', fontWeight: 'bold', fontSize: '12px',
              letterSpacing: '0.05em',
            }}
          >
            {analyzing ? 'ANALYZING…' : 'ANALYZE'}
          </button>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '20px' }}>✕</button>
        </div>
      </div>

      {analyzeError && (
        <div style={{ color: '#ff6b6b', fontSize: '12px', marginBottom: '8px' }}>{analyzeError}</div>
      )}

      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flex: 1, minHeight: 0 }}>
        {cameras.map(cam => {
          const clipUrl = `${backendUrl}/clips/${cam.id}/bounce_${bounceFrame}_${flightIdStr}.mp4`
          const landing = landingByCam[cam.id]

          return (
            <div key={cam.id} style={{ flex: 1, background: '#000', borderRadius: '8px', overflow: 'hidden', position: 'relative' }}>
              <div style={{ position: 'absolute', top: 8, left: 8, background: 'rgba(0,0,0,0.6)', padding: '4px 8px', fontSize: '12px', color: '#fff', borderRadius: '4px', zIndex: 2 }}>
                {cam.label}
                {landing && (
                  <span style={{ marginLeft: 8, color: '#ff8888' }}>
                    bounce f{landing.frameIndex}
                  </span>
                )}
              </div>
              <video
                ref={cam.ref}
                src={clipUrl}
                muted={cam.id !== 'hq'}
                playsInline
                crossOrigin="anonymous"
                onTimeUpdate={(e) => {
                  if (cam.id === 'hq') {
                    setProgress(e.target.currentTime)
                    if (e.target.currentTime >= e.target.duration) setPlaying(false)
                  }
                }}
                onLoadedMetadata={(e) => {
                  if (cam.id === 'hq') setDuration(e.target.duration || 2)
                }}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
              <BounceLandingOverlay
                videoRef={cam.ref}
                result={landing}
                visible={analyzed}
              />
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
        <button onClick={handlePlayPause} style={{
          background: 'linear-gradient(135deg, var(--amber, #f5a623), #d48812)', color: '#000', border: 'none',
          width: '40px', height: '40px', borderRadius: '50%', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px',
        }}>
          {playing ? '⏸' : '▶'}
        </button>
        <button onClick={handleNext} disabled={currentIndex >= events.length - 1 || currentIndex === -1} style={{
          background: 'rgba(255,255,255,0.1)', color: (currentIndex >= events.length - 1 || currentIndex === -1) ? 'rgba(255,255,255,0.2)' : '#fff', border: 'none',
          padding: '8px 16px', borderRadius: '6px', cursor: (currentIndex >= events.length - 1 || currentIndex === -1) ? 'default' : 'pointer', fontWeight: 'bold', fontSize: '12px',
        }}>
          NEXT EVENT ▶
        </button>
        <div style={{ flex: 1, position: 'relative' }}>
          {landingMarkerPct != null && (
            <div
              style={{
                position: 'absolute',
                left: `${landingMarkerPct}%`,
                top: '-6px',
                width: '3px',
                height: '22px',
                background: '#ff4444',
                borderRadius: '2px',
                transform: 'translateX(-50%)',
                pointerEvents: 'none',
                zIndex: 2,
              }}
            />
          )}
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
