import { useRef, useCallback, useState, useEffect, useMemo } from 'react'

const BOUNCE_GAP_SEC = 6

function toFraction(t, start, end) {
  if (end <= start) return 0
  return Math.max(0, Math.min(1, (t - start) / (end - start)))
}

/** Stable identity for one dot per physical bounce (never include time — it drifts each poll). */
function bounceIdentityKey(ev) {
  const bf = ev.bounce_frame ?? ev.metadata?.bounce_frame
  if (bf != null && bf !== '') return `bf-${bf}`
  if (ev.hq_frame != null) return `hq-${ev.hq_frame}`
  return `id-${ev.id}`
}

/** React render key — same as identity; time must not be part of the key. */
function bounceEventKey(ev) {
  return bounceIdentityKey(ev)
}

export default function SeekBar({
  currentTime,
  liveEdge,
  bufferStart,
  bufferedEnd,
  segments,
  events = [],
  onSeek,
  onEventSelect,
  mode,
  isPlaying,
  onTogglePlay,
  playbackRate,
  onPlaybackRateChange
}) {
  const trackRef = useRef(null)
  const dragging = useRef(false)
  const [hoveredEvent, setHoveredEvent] = useState(null)
  const [internalEventTime, setInternalEventTime] = useState(null)
  const [dragTime, setDragTime] = useState(null)
  const lastSeekRef = useRef(0)

  // Clear internal pointer when mode changes
  useEffect(() => {
    setInternalEventTime(null)
  }, [mode])

  const segs = segments ?? []
  const segsStart = segs.length > 0 ? segs[0].start : null
  const segsEnd = segs.length > 0 ? segs[segs.length - 1].end : null

  const rangeStart = mode === 'live' && liveEdge !== null ? Math.max(0, liveEdge - 180) : (segsStart ?? bufferStart ?? (liveEdge !== null ? liveEdge - 180 : 0))
  const rangeEnd = mode === "live" && liveEdge !== null ? Math.max(liveEdge, currentTime) : Math.max(segsEnd ?? -Infinity, liveEdge ?? -Infinity, currentTime)

  const seekFromEvent = useCallback((e, isFinal = false) => {
    const rect = trackRef.current.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    let targetTime = rangeStart + frac * (rangeEnd - rangeStart)
    if (mode === 'live' && liveEdge !== null) {
      targetTime = Math.min(targetTime, liveEdge)
    }
    
    setDragTime(targetTime)
    
    const now = performance.now()
    if (isFinal || now - lastSeekRef.current > 150) {
      onSeek(targetTime, true)
      lastSeekRef.current = now
    }
  }, [rangeStart, rangeEnd, onSeek, mode, liveEdge])

  const onMouseDown = (e) => {
    dragging.current = true
    seekFromEvent(e, true)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }
  const onMouseMove = useCallback((e) => {
    if (dragging.current) {
      e.preventDefault()
      seekFromEvent(e, false)
    }
  }, [seekFromEvent])
  const onMouseUp = useCallback((e) => {
    if (dragging.current) {
      dragging.current = false
      seekFromEvent(e, true)
    }
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
  }, [onMouseMove, seekFromEvent])

  // Keep scrub preview until App currentTime catches up (prevents playhead snap on release)
  useEffect(() => {
    if (dragTime === null) return
    if (Math.abs(currentTime - dragTime) < 0.35) {
      setDragTime(null)
    }
  }, [currentTime, dragTime])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'ArrowLeft') {
        const referenceTime = internalEventTime !== null ? internalEventTime : currentTime;
        const validEvents = events.filter(ev => ev.time <= (liveEdge !== null ? liveEdge : currentTime));
        const prevEvents = validEvents.filter(ev => ev.time < referenceTime - 0.5).sort((a, b) => b.time - a.time);
        if (prevEvents.length > 0) {
          if (onSeek) onSeek(prevEvents[0].time, mode === 'review')
          setInternalEventTime(prevEvents[0].time);
          if (onEventSelect) onEventSelect(prevEvents[0]);
        }
      } else if (e.key === 'ArrowRight') {
        const referenceTime = internalEventTime !== null ? internalEventTime : currentTime;
        const validEvents = events.filter(ev => ev.time <= (liveEdge !== null ? liveEdge : currentTime));
        const nextEvents = validEvents.filter(ev => ev.time > referenceTime + 0.5).sort((a, b) => a.time - b.time);
        if (nextEvents.length > 0) {
          if (onSeek) onSeek(nextEvents[0].time, mode === 'review')
          setInternalEventTime(nextEvents[0].time);
          if (onEventSelect) onEventSelect(nextEvents[0]);
        }
      } else if (e.key === ' ') {
        // Prevent browser scrolling
        e.preventDefault();
        if (onTogglePlay) onTogglePlay();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentTime, events, onSeek, onEventSelect, mode, liveEdge, internalEventTime, onTogglePlay]);

  const activeTime = dragTime !== null ? dragTime : currentTime
  const playedFrac = toFraction(activeTime, rangeStart, rangeEnd)
  const bufferedFrac = toFraction(bufferedEnd ?? currentTime, rangeStart, rangeEnd)

  const visibleTicks = (segments || []).filter(
    s => s.start > rangeStart && s.start < rangeEnd
  )

  const visibleEvents = useMemo(() => {
    const byKey = new Map()
    for (const ev of events) {
      if (ev.time < rangeStart || ev.time > rangeEnd) continue
      const k = bounceEventKey(ev)
      const prev = byKey.get(k)
      if (!prev || ev.time >= prev.time) byKey.set(k, ev)
    }
    return [...byKey.values()].sort((a, b) => a.time - b.time)
  }, [events, rangeStart, rangeEnd])

  const longGapEventKeys = useMemo(() => {
    const sorted = [...visibleEvents]
    const keys = new Set()
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].time - sorted[i - 1].time > BOUNCE_GAP_SEC) {
        keys.add(bounceEventKey(sorted[i]))
      }
    }
    return keys
  }, [visibleEvents])

  const behind = liveEdge && activeTime
    ? Math.round(liveEdge - activeTime)
    : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontSize: '9px', letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            {mode === 'review' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (onSeek) onSeek(activeTime - (1/30), true);
                }}
                style={{
                  background: 'rgba(255, 255, 255, 0.08)', border: '1px solid rgba(255, 255, 255, 0.2)',
                  color: '#f4f4f5', borderRadius: '10px', cursor: 'pointer', fontSize: '9px',
                  fontFamily: "Inter, system-ui, -apple-system, sans-serif",
                  padding: '2px 9px', fontWeight: '700', letterSpacing: '0.06em', transition: 'all 0.2s ease',
                  backdropFilter: 'blur(10px)', boxShadow: '0 2px 6px rgba(0,0,0,0.25)'
                }}
              >
                −1 FRAME
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (onTogglePlay) onTogglePlay();
              }}
              style={{
                background: 'linear-gradient(135deg, #ffffff, #d4d4d8)',
                border: 'none',
                color: '#000',
                borderRadius: '50%',
                cursor: 'pointer',
                fontSize: '9px',
                width: '20px',
                height: '20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 'bold',
                boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                transition: 'all 0.2s'
              }}
            >
              {isPlaying ? '⏸' : '▶'}
            </button>
            {mode === 'review' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (onSeek) onSeek(activeTime + (1/30), true);
                }}
                style={{
                  background: 'rgba(255, 255, 255, 0.08)', border: '1px solid rgba(255, 255, 255, 0.2)',
                  color: '#f4f4f5', borderRadius: '10px', cursor: 'pointer', fontSize: '9px',
                  fontFamily: "Inter, system-ui, -apple-system, sans-serif",
                  padding: '2px 9px', fontWeight: '700', letterSpacing: '0.06em', transition: 'all 0.2s ease',
                  backdropFilter: 'blur(10px)', boxShadow: '0 2px 6px rgba(0,0,0,0.25)'
                }}
              >
                +1 FRAME
              </button>
            )}
            {mode === 'review' && (
              <select
                value={playbackRate}
                onChange={(e) => onPlaybackRateChange && onPlaybackRateChange(parseFloat(e.target.value))}
                style={{
                  background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)',
                  color: '#f4f4f5', borderRadius: '10px', cursor: 'pointer', fontSize: '9px',
                  fontFamily: "Inter, system-ui, -apple-system, sans-serif",
                  padding: '2px 6px', marginLeft: '2px', fontWeight: '700', outline: 'none',
                  letterSpacing: '0.04em', backdropFilter: 'blur(10px)'
                }}
              >
                <option value={0.25} style={{ background: '#1c1c24' }}>0.25x</option>
                <option value={0.5} style={{ background: '#1c1c24' }}>0.5x</option>
                <option value={1.0} style={{ background: '#1c1c24' }}>1.0x</option>
              </select>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {mode === 'live' && behind !== null && behind > 3 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (liveEdge !== null) onSeek(liveEdge);
              }}
              style={{
                background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                border: 'none',
                color: '#fff',
                borderRadius: '10px',
                cursor: 'pointer',
                fontSize: '9px',
                padding: '2px 8px',
                fontWeight: '700',
                letterSpacing: '0.05em',
                boxShadow: '0 2px 6px rgba(239, 68, 68, 0.4)',
                transition: 'all 0.2s'
              }}
            >
              GO LIVE
            </button>
          )}
          <span style={{ fontFamily: 'monospace', fontSize: '10px', fontWeight: '700', color: (mode === 'live' && behind !== null && behind > 3) ? 'rgba(255,255,255,0.4)' : '#10b981' }}>
            {(mode === 'live' && behind !== null && behind > 3) ? `−${behind}s` : '● LIVE'}
          </span>
        </div>
      </div>

      {/* Track Container */}
      <div
        ref={trackRef}
        onMouseDown={onMouseDown}
        style={{ position: 'relative', height: '14px', cursor: 'col-resize', display: 'flex', alignItems: 'center' }}
      >
        <div style={{
          position: 'absolute', left: 0, right: 0, height: '4px',
          background: 'rgba(255,255,255,0.08)', borderRadius: '2px', overflow: 'hidden',
          border: '1px solid rgba(255,255,255,0.05)'
        }}>
          <div style={{
            position: 'absolute', left: 0, width: `${bufferedFrac * 100}%`, height: '100%',
            background: 'rgba(255,255,255,0.2)', borderRadius: '2px',
          }} />
          <div style={{
            position: 'absolute', left: 0, width: `${playedFrac * 100}%`, height: '100%',
            background: 'linear-gradient(90deg, #3b82f6, #60a5fa)', borderRadius: '2px',
          }} />
        </div>

        {/* EVENT DOTS (Exact Same Size as Playhead Thumb: 10px) */}
        {visibleEvents.map((ev) => {
          const frac = toFraction(ev.time, rangeStart, rangeEnd)
          const evKey = bounceEventKey(ev)
          const isLongGap = longGapEventKeys.has(evKey)
          const isHovered = hoveredEvent && bounceEventKey(hoveredEvent) === evKey
          const isCurrent = Math.abs(activeTime - ev.time) < 1.0
          const isPast = ev.time <= activeTime
          const dotColor = isLongGap ? '#ef4444' : '#ffffff'
          const hoverGlow = isLongGap ? 'rgba(239, 68, 68, 0.9)' : 'rgba(255, 255, 255, 0.9)'

          return (
            <div
              key={evKey}
              onMouseEnter={() => setHoveredEvent(ev)}
              onMouseLeave={() => setHoveredEvent(null)}
              onClick={(e) => {
                e.stopPropagation()
                if (onEventSelect) onEventSelect(ev)
                if (onSeek) onSeek(ev.time, true)
                if (isPlaying && onTogglePlay) onTogglePlay()
              }}
              style={{
                position: 'absolute', left: `${frac * 100}%`,
                width: '20px', height: '20px',
                transform: 'translate(-50%, -50%)', 
                top: '50%',
                zIndex: isHovered || isCurrent ? 4 : 3, 
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                pointerEvents: 'auto',
              }}
            >
              <div style={{
                width: isCurrent || isHovered ? '10px' : '7.5px', 
                height: isCurrent || isHovered ? '10px' : '7.5px',
                borderRadius: '50%', 
                background: dotColor,
                boxShadow: isHovered ? `0 0 10px 3px ${hoverGlow}` : (isCurrent ? '0 0 8px rgba(255,255,255,0.9)' : 'none'),
                transition: 'all 0.2s ease', 
                border: '1px solid rgba(0,0,0,0.6)',
                opacity: isPast || isHovered ? 1 : 0.8,
              }} />
            </div>
          )
        })}

        {/* Playhead Glowing Thumb */}
        <div style={{
          position: 'absolute', left: `${playedFrac * 100}%`, transform: 'translateX(-50%)',
          width: '10px', height: '10px', borderRadius: '50%', background: '#fff',
          boxShadow: '0 0 8px rgba(96,165,250,0.9), 0 0 0 2px rgba(255,255,255,0.3)',
          pointerEvents: 'none', zIndex: 5,
        }} />

        <div style={{
          position: 'absolute', right: 0, width: '2px', height: '10px', background: '#ef4444',
          borderRadius: '1px', opacity: 0.9, pointerEvents: 'none',
        }} />
      </div>

      <div style={{ position: 'relative', height: '10px', fontSize: '8px', fontFamily: 'monospace', color: 'rgba(255,255,255,0.4)' }}>
        <span style={{ position: 'absolute', left: 0 }}>{formatOffset(rangeStart - (liveEdge ?? rangeStart))}</span>
        <span style={{ position: 'absolute', right: 0, color: '#ef4444', opacity: 0.8, fontWeight: 'bold' }}>EDGE</span>
      </div>
    </div>
  )
}

function formatOffset(seconds) {
  const s = Math.round(Math.abs(seconds))
  return seconds < -1 ? `−${s}s` : '0s'
}
