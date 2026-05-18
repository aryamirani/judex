import { useEffect, useRef } from 'react'

function formatOffset(seconds) {
  if (seconds < 1) return 'LIVE'
  if (seconds < 60) return `−${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `−${m}m${s.toString().padStart(2, '0')}s`
}

export default function SegmentList({
  segments,
  currentTime,
  liveEdge,
  onPlaySegment,   // (seg) => void — play only that segment then pause
  onGoLive,        // () => void   — resume live stream
  onClose,
}) {
  const listRef   = useRef(null)
  const activeRef = useRef(null)

  // show all archived segments — IDB can hold hundreds; user can scroll
  const visible = segments

  const activeIdx = visible.findIndex(
    s => currentTime >= s.start && currentTime < s.end
  )

  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [activeIdx])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault()
        const next = activeIdx < visible.length - 1 ? activeIdx + 1 : activeIdx
        if (visible[next]) onPlaySegment(visible[next])
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault()
        const prev = activeIdx > 0 ? activeIdx - 1 : 0
        if (visible[prev]) onPlaySegment(visible[prev])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeIdx, visible, onPlaySegment, onClose])

  return (
    <div style={{
      position: 'absolute',
      bottom: '80px',
      right: '16px',
      width: '268px',
      maxHeight: '360px',
      background: 'rgba(10,10,10,0.97)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '6px',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      boxShadow: '0 8px 40px rgba(0,0,0,0.7)',
      animation: 'slideUp 0.18s ease',
      zIndex: 20,
    }}>
      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .seg-row:hover { background: rgba(245,166,35,0.07) !important; }
      `}</style>

      {/* header */}
      <div style={{
        display: 'flex', alignItems: 'center',
        justifyContent: 'space-between',
        padding: '9px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <span style={{
          fontFamily: 'var(--condensed)', fontSize: '11px',
          letterSpacing: '0.15em', textTransform: 'uppercase',
          color: 'var(--muted)',
        }}>
          Archive · {visible.length} segments
        </span>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {['‹', '›'].map((arrow, i) => (
            <button key={i}
              onClick={() => {
                const target = i === 0
                  ? (activeIdx > 0 ? activeIdx - 1 : 0)
                  : (activeIdx < visible.length - 1 ? activeIdx + 1 : activeIdx)
                if (visible[target]) onPlaySegment(visible[target])
              }}
              style={{
                background: 'none', border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '3px', color: 'var(--muted)', fontSize: '14px',
                lineHeight: 1, cursor: 'pointer', padding: '1px 5px',
              }}
            >
              {arrow}
            </button>
          ))}
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--muted)',
            fontSize: '16px', cursor: 'pointer', lineHeight: 1, padding: '0 2px',
          }}>×</button>
        </div>
      </div>

      {/* segment list */}
      <div ref={listRef} style={{ overflowY: 'auto', flex: 1 }}>
        {visible.length === 0 ? (
          <div style={{
            padding: '24px', textAlign: 'center',
            color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: '11px',
          }}>
            Waiting for segments…
          </div>
        ) : (
          visible.map((seg, i) => {
            const isActive = i === activeIdx
            const offsetSec = liveEdge ? liveEdge - seg.start : null
            const dur = seg.end - seg.start
            const progress = isActive
              ? Math.min(1, (currentTime - seg.start) / dur)
              : 0

            return (
              <div
                key={seg.start}
                ref={isActive ? activeRef : null}
                className="seg-row"
                onClick={() => onPlaySegment(seg)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '7px 12px', cursor: 'pointer',
                  borderLeft: isActive ? '2px solid var(--amber)' : '2px solid transparent',
                  background: isActive ? 'rgba(245,166,35,0.09)' : 'transparent',
                  transition: 'background 0.12s',
                }}
              >
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: '10px',
                  color: isActive ? 'var(--amber)' : 'rgba(255,255,255,0.2)',
                  width: '24px', flexShrink: 0, textAlign: 'right',
                }}>
                  {i + 1}
                </span>

                <div style={{
                  flex: 1, height: '2px', borderRadius: '1px',
                  background: 'rgba(255,255,255,0.06)', overflow: 'hidden', position: 'relative',
                }}>
                  <div style={{
                    position: 'absolute', left: 0, height: '100%',
                    width: isActive ? `${progress * 100}%` : '100%',
                    background: isActive ? 'var(--amber)' : 'rgba(255,255,255,0.12)',
                  }} />
                </div>

                <span style={{
                  fontFamily: 'var(--mono)', fontSize: '10px',
                  color: isActive ? 'var(--amber)' : 'var(--muted)',
                  width: '44px', textAlign: 'right', flexShrink: 0,
                }}>
                  {offsetSec !== null ? formatOffset(offsetSec) : '—'}
                </span>

                <span style={{
                  fontFamily: 'var(--mono)', fontSize: '10px',
                  color: 'rgba(255,255,255,0.18)',
                  width: '30px', textAlign: 'right', flexShrink: 0,
                }}>
                  {dur.toFixed(1)}s
                </span>
              </div>
            )
          })
        )}
      </div>

      {/* footer: GO LIVE button + keyboard hint */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 12px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
        gap: '8px',
      }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: '9px',
          color: 'rgba(255,255,255,0.15)',
        }}>
          ↑↓ navigate · esc close
        </span>

        <button
          onClick={onGoLive}
          style={{
            display: 'flex', alignItems: 'center', gap: '5px',
            background: 'var(--red)',
            border: 'none',
            borderRadius: '3px',
            padding: '4px 10px',
            cursor: 'pointer',
            fontFamily: 'var(--condensed)',
            fontSize: '11px',
            fontWeight: 600,
            letterSpacing: '0.12em',
            color: '#fff',
            textTransform: 'uppercase',
            flexShrink: 0,
          }}
        >
          <span style={{
            width: '5px', height: '5px', borderRadius: '50%',
            background: '#fff',
            animation: 'livePulse 1.4s ease-in-out infinite',
          }} />
          Go Live
          <style>{`
            @keyframes livePulse {
              0%, 100% { opacity: 1; }
              50%       { opacity: 0.3; }
            }
          `}</style>
        </button>
      </div>
    </div>
  )
}
