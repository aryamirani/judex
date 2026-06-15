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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontSize: '10px', fontFamily: 'var(--condensed)', letterSpacing: '0.1em',
        textTransform: 'uppercase', color: 'var(--muted)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '4px' }}>
            {mode === 'review' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  // scrub backwards 1 frame (assuming 60fps)
                  if (onSeek) onSeek(activeTime - (1/60), true);
                }}
                style={{ background: '#333', border: '1px solid #555', color: '#fff', borderRadius: '6px', cursor: 'pointer', fontSize: '11px', padding: '4px 10px', fontWeight: 'bold', transition: 'background 0.2s' }}
              >
                -1 FRAME
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (onTogglePlay) onTogglePlay();
              }}
              style={{
                background: 'linear-gradient(135deg, var(--amber, #f5a623), #d48812)',
                border: 'none',
                color: '#000',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '12px',
                padding: '4px 12px',
                fontWeight: 'bold',
                minWidth: '40px',
                boxShadow: '0 2px 8px rgba(245, 166, 35, 0.3)'
              }}
            >
              {isPlaying ? '⏸' : '▶'}
            </button>
            {mode === 'review' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  // scrub forwards 1 frame (assuming 60fps)
                  if (onSeek) onSeek(activeTime + (1/60), true);
                }}
                style={{ background: '#333', border: '1px solid #555', color: '#fff', borderRadius: '6px', cursor: 'pointer', fontSize: '11px', padding: '4px 10px', fontWeight: 'bold', transition: 'background 0.2s' }}
              >
                +1 FRAME
              </button>
            )}
            {mode === 'review' && (
              <select
                value={playbackRate}
                onChange={(e) => onPlaybackRateChange && onPlaybackRateChange(parseFloat(e.target.value))}
                style={{
                  background: '#333', border: '1px solid #555', color: '#fff', borderRadius: '6px', cursor: 'pointer', fontSize: '11px', padding: '4px 8px', marginLeft: '8px', fontWeight: 'bold'
                }}
              >
                <option value={0.25}>0.25x</option>
                <option value={0.5}>0.5x</option>
                <option value={1.0}>1x</option>
              </select>
            )}
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
        {visibleEvents.map((ev) => {
          const frac = toFraction(ev.time, rangeStart, rangeEnd)
          const evKey = bounceEventKey(ev)
          const isLongGap = longGapEventKeys.has(evKey)
          const isHovered = hoveredEvent && bounceEventKey(hoveredEvent) === evKey
          const isCurrent = Math.abs(activeTime - ev.time) < 1.0
          const isPast = ev.time <= activeTime
          const dotColor = isCurrent ? '#fff' : (isLongGap ? '#4a90e2' : 'var(--amber)')
          const hoverGlow = isLongGap ? 'rgba(74,144,226,0.8)' : 'rgba(245,166,35,0.8)'
 
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
                background: dotColor,
                boxShadow: isHovered ? `0 0 12px 4px ${hoverGlow}` : (isCurrent ? '0 0 10px rgba(255,255,255,0.8)' : 'none'),
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
