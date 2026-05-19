export default function LiveBadge({ isLive, onClick }) {
  return (
    <button
      onClick={onClick}
      title={isLive ? 'At live edge' : 'Jump to live'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        background: isLive ? 'var(--red)' : 'rgba(255,48,48,0.18)',
        border: `1px solid ${isLive ? 'var(--red)' : 'rgba(255,48,48,0.4)'}`,
        borderRadius: '3px',
        padding: '3px 8px',
        cursor: isLive ? 'default' : 'pointer',
        fontFamily: 'var(--condensed)',
        fontSize: '12px',
        fontWeight: 600,
        letterSpacing: '0.12em',
        color: isLive ? '#fff' : 'rgba(255,80,80,0.9)',
        textTransform: 'uppercase',
        transition: 'all 0.2s ease',
        flexShrink: 0,
      }}
    >
      <span style={{
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: isLive ? '#fff' : 'rgba(255,80,80,0.7)',
        animation: isLive ? 'pulse 1.4s ease-in-out infinite' : 'none',
      }} />
      LIVE
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.4; transform: scale(0.7); }
        }
      `}</style>
    </button>
  )
}
