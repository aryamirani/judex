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
  mode
}) {
  const trackRef = useRef(null)
  const dragging = useRef(false)
  const [hoveredEvent, setHoveredEvent] = useState(null)

  const segs = segments ?? []
  const segsStart = segs.length > 0 ? segs[0].start : null
  const segsEnd = segs.length > 0 ? segs[segs.length - 1].end : null

  const rangeStart = segsStart ?? bufferStart ?? (liveEdge !== null ? liveEdge - 80 : 0)
  const rangeEnd = Math.max(segsEnd ?? -Infinity, liveEdge ?? -Infinity, currentTime)

  const seekFromEvent = useCallback((e) => {
    const rect = trackRef.current.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const targetTime = rangeStart + frac * (rangeEnd - rangeStart)
    onSeek(targetTime)
  }, [rangeStart, rangeEnd, onSeek])

  const onMouseDown = (e) => {
    if (mode !== 'review') return;
    dragging.current = true
    seekFromEvent(e)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }
  const onMouseMove = useCallback((e) => {
    if (dragging.current) seekFromEvent(e)
  }, [seekFromEvent])
  const onMouseUp = useCallback(() => {
    dragging.current = false
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
  }, [onMouseMove])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'ArrowLeft') {
        const prevEvents = events.filter(ev => ev.time < currentTime - 0.5).sort((a, b) => b.time - a.time);
        if (prevEvents.length > 0) {
          if (mode === 'review') onSeek(prevEvents[0].time);
          if (onEventSelect) onEventSelect(prevEvents[0]);
        }
      } else if (e.key === 'ArrowRight') {
        const nextEvents = events.filter(ev => ev.time > currentTime + 0.5).sort((a, b) => a.time - b.time);
        if (nextEvents.length > 0) {
          if (mode === 'review') onSeek(nextEvents[0].time);
          if (onEventSelect) onEventSelect(nextEvents[0]);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentTime, events, onSeek, onEventSelect, mode]);

  const playedFrac = toFraction(currentTime, rangeStart, rangeEnd)
  const bufferedFrac = toFraction(bufferedEnd ?? currentTime, rangeStart, rangeEnd)

  const visibleTicks = (segments || []).filter(
    s => s.start > rangeStart && s.start < rangeEnd
  )

  const visibleEvents = events.filter(
    ev => ev.time >= rangeStart && ev.time <= rangeEnd
  )

  const behind = liveEdge && currentTime
    ? Math.round(liveEdge - currentTime)
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
                const prevEvents = events.filter(ev => ev.time < currentTime - 0.5).sort((a, b) => b.time - a.time);
                if (prevEvents.length > 0) {
                  if (mode === 'review') onSeek(prevEvents[0].time);
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
                const nextEvents = events.filter(ev => ev.time > currentTime + 0.5).sort((a, b) => a.time - b.time);
                if (nextEvents.length > 0) {
                  if (mode === 'review') onSeek(nextEvents[0].time);
                  if (onEventSelect) onEventSelect(nextEvents[0]);
                }
              }}
              style={{ background: '#222', border: '1px solid #444', color: '#fff', borderRadius: '4px', cursor: 'pointer', fontSize: '9px', padding: '2px 6px' }}
            >
              NEXT ▶
            </button>
          </div>
        </div>
        <span style={{ fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--amber)' }}>
          {behind !== null && behind > 1 ? `−${behind}s` : 'LIVE'}
        </span>
      </div>

      <div
        ref={trackRef}
        onMouseDown={onMouseDown}
        style={{ position: 'relative', height: '24px', cursor: mode === 'review' ? 'col-resize' : 'default', display: 'flex', alignItems: 'center' }}
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

        {visibleTicks.map((seg, i) => {
          const frac = toFraction(seg.start, rangeStart, rangeEnd)
          return (
            <div key={i} style={{
              position: 'absolute', left: `${frac * 100}%`, width: '1px', height: '10px',
              background: 'rgba(255,255,255,0.18)', transform: 'translateX(-0.5px)', pointerEvents: 'none',
            }} />
          )
        })}

        {visibleEvents.map((ev, i) => {
          const frac = toFraction(ev.time, rangeStart, rangeEnd)
          const isHovered = hoveredEvent?.id === ev.id
          // highlight if close to current time
          const isCurrent = Math.abs(currentTime - ev.time) < 1.0

          return (
            <div
              key={i}
              onMouseEnter={() => setHoveredEvent(ev)}
              onMouseLeave={() => setHoveredEvent(null)}
              onClick={(e) => { e.stopPropagation(); if (mode === 'review') onSeek(ev.time); if (onEventSelect) onEventSelect(ev); }}
              style={{
                position: 'absolute', left: `${frac * 100}%`,
                width: isCurrent ? '12px' : '8px', height: isCurrent ? '12px' : '8px',
                borderRadius: '50%', background: isCurrent ? '#fff' : 'var(--amber)',
                transform: 'translate(-50%, 0)', cursor: 'pointer',
                boxShadow: isCurrent ? '0 0 10px rgba(255,255,255,0.8)' : 'none',
                zIndex: 3, transition: 'all 0.2s', border: '1px solid #000'
              }}>
              {isHovered && (
                <div style={{
                  position: 'absolute', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
                  background: 'rgba(0,0,0,0.9)', color: '#fff', padding: '4px 8px', borderRadius: '4px',
                  fontSize: '10px', whiteSpace: 'nowrap', pointerEvents: 'none', border: '1px solid var(--border)'
                }}>
                  Shot {ev.id}
                </div>
              )}
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
