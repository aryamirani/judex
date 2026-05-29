import { useRef, useCallback, useState, useEffect } from 'react'

function toFraction(t, start, end) {
  if (end <= start) return 0
  return Math.max(0, Math.min(1, (t - start) / (end - start)))
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
  onTogglePlay
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
      onSeek(targetTime)
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
      setDragTime(null)
    }
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
  }, [onMouseMove])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'ArrowLeft') {
        const referenceTime = internalEventTime !== null ? internalEventTime : currentTime;
        const validEvents = events.filter(ev => ev.time <= (liveEdge !== null ? liveEdge : currentTime));
        const prevEvents = validEvents.filter(ev => ev.time < referenceTime - 0.5).sort((a, b) => b.time - a.time);
        if (prevEvents.length > 0) {
          if (mode === 'review' && onSeek) onSeek(prevEvents[0].time);
          setInternalEventTime(prevEvents[0].time);
          if (onEventSelect) onEventSelect(prevEvents[0]);
        }
      } else if (e.key === 'ArrowRight') {
        const referenceTime = internalEventTime !== null ? internalEventTime : currentTime;
        const validEvents = events.filter(ev => ev.time <= (liveEdge !== null ? liveEdge : currentTime));
        const nextEvents = validEvents.filter(ev => ev.time > referenceTime + 0.5).sort((a, b) => a.time - b.time);
        if (nextEvents.length > 0) {
          if (mode === 'review' && onSeek) onSeek(nextEvents[0].time);
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

  const visibleEvents = events.filter(
    ev => ev.time >= rangeStart && ev.time <= rangeEnd
  )

  const behind = liveEdge && activeTime
    ? Math.round(liveEdge - activeTime)
    : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontSize: '10px', fontFamily: 'var(--condensed)', letterSpacing: '0.1em',
        textTransform: 'uppercase', color: 'var(--muted)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span>DVR Window · last 30 segments</span>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                const referenceTime = internalEventTime !== null ? internalEventTime : currentTime;
                const validEvents = events.filter(ev => ev.time <= (liveEdge !== null ? liveEdge : currentTime));
                const prevEvents = validEvents.filter(ev => ev.time < referenceTime - 0.5).sort((a, b) => b.time - a.time);
                if (prevEvents.length > 0) {
                  if (mode === 'review' && onSeek) onSeek(prevEvents[0].time);
                  setInternalEventTime(prevEvents[0].time);
                  if (onEventSelect) onEventSelect(prevEvents[0]);
                }
              }}
              style={{ background: '#222', border: '1px solid #444', color: '#fff', borderRadius: '4px', cursor: 'pointer', fontSize: '9px', padding: '2px 6px' }}
            >
              ◀ PREV
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (onTogglePlay) onTogglePlay();
              }}
              style={{
                background: 'var(--amber, #f5a623)',
                border: 'none',
                color: '#000',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '9px',
                padding: '2px 8px',
                fontWeight: 'bold',
                minWidth: '55px'
              }}
            >
              {isPlaying ? 'PAUSE' : 'PLAY'}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                const referenceTime = internalEventTime !== null ? internalEventTime : activeTime;
                const validEvents = events.filter(ev => ev.time <= (liveEdge !== null ? liveEdge : activeTime));
                const nextEvents = validEvents.filter(ev => ev.time > referenceTime + 0.5).sort((a, b) => a.time - b.time);
                if (nextEvents.length > 0) {
                  if (mode === 'review' && onSeek) onSeek(nextEvents[0].time);
                  setInternalEventTime(nextEvents[0].time);
                  if (onEventSelect) onEventSelect(nextEvents[0]);
                }
              }}
              style={{ background: '#222', border: '1px solid #444', color: '#fff', borderRadius: '4px', cursor: 'pointer', fontSize: '9px', padding: '2px 6px' }}
            >
              NEXT ▶
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {mode === 'live' && behind !== null && behind > 3 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (liveEdge !== null) onSeek(liveEdge);
              }}
              style={{
                background: 'var(--red)',
                border: 'none',
                color: '#fff',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '11px',
                padding: '4px 12px',
                fontWeight: 'bold',
                letterSpacing: '0.05em',
                transition: 'all 0.2s'
              }}
            >
              GO LIVE
            </button>
          )}
          <span style={{ fontFamily: 'var(--mono)', fontSize: '11px', color: (mode === 'live' && behind !== null && behind > 3) ? 'var(--muted)' : 'var(--amber)' }}>
            {(mode === 'live' && behind !== null && behind > 3) ? `−${behind}s` : 'LIVE'}
          </span>
        </div>
      </div>
 
      <div
        ref={trackRef}
        onMouseDown={onMouseDown}
        style={{ position: 'relative', height: '24px', cursor: 'col-resize', display: 'flex', alignItems: 'center' }}
      >
        <div style={{
          position: 'absolute', left: 0, right: 0, height: '4px',
          background: 'rgba(255,255,255,0.07)', borderRadius: '2px', overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', left: 0, width: `${bufferedFrac * 100}%`, height: '100%',
            background: 'rgba(245,166,35,0.22)',
          }} />
          <div style={{
            position: 'absolute', left: 0, width: `${playedFrac * 100}%`, height: '100%',
            background: 'var(--amber)',
          }} />
        </div>
 
        {/* SEGMENT TICKS — hidden
        {visibleTicks.map((seg, i) => {
          const frac = toFraction(seg.start, rangeStart, rangeEnd)
          return (
            <div key={i} style={{
              position: 'absolute', left: `${frac * 100}%`, width: '1px', height: '10px',
              background: 'rgba(255,255,255,0.18)', transform: 'translateX(-0.5px)', pointerEvents: 'none',
            }} />
          )
        })}
        */}
 
        {/* EVENT DOTS */}
        {visibleEvents.map((ev, i) => {
          const frac = toFraction(ev.time, rangeStart, rangeEnd)
          const isHovered = hoveredEvent?.id === ev.id
          // highlight if close to current time
          const isCurrent = Math.abs(activeTime - ev.time) < 1.0
          const isPast = ev.time <= activeTime
 
          return (
            <div
              key={i}
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
                width: '24px', height: '24px',
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
                width: isCurrent || isHovered ? '12px' : '8px', 
                height: isCurrent || isHovered ? '12px' : '8px',
                borderRadius: '50%', 
                background: isCurrent ? '#fff' : 'var(--amber)',
                boxShadow: isHovered ? '0 0 12px 4px rgba(245,166,35,0.8)' : (isCurrent ? '0 0 10px rgba(255,255,255,0.8)' : 'none'),
                transition: 'background 0.2s, width 0.2s, height 0.2s, box-shadow 0.2s, opacity 0.2s', 
                border: '1px solid #000',
                opacity: isPast || isHovered ? 1 : 0.25,
              }} />
            </div>
          )
        })}

        <div style={{
          position: 'absolute', left: `${playedFrac * 100}%`, transform: 'translateX(-50%)',
          width: '12px', height: '12px', borderRadius: '50%', background: 'var(--amber)',
          boxShadow: '0 0 0 2px rgba(245,166,35,0.3)', pointerEvents: 'none', zIndex: 2,
        }} />

        <div style={{
          position: 'absolute', right: 0, width: '2px', height: '14px', background: 'var(--red)',
          borderRadius: '1px', opacity: 0.8, pointerEvents: 'none',
        }} />
      </div>

      <div style={{ position: 'relative', height: '12px', fontSize: '9px', fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
        <span style={{ position: 'absolute', left: 0 }}>{formatOffset(rangeStart - (liveEdge ?? rangeStart))}</span>
        <span style={{ position: 'absolute', right: 0, color: 'var(--red)', opacity: 0.7 }}>EDGE</span>
      </div>
    </div>
  )
}

function formatOffset(seconds) {
  const s = Math.round(Math.abs(seconds))
  return seconds < -1 ? `−${s}s` : '0s'
}
