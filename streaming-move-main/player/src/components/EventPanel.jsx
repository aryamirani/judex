import React, { useRef, useState, useEffect } from 'react';

export default function EventPanel({ event, events = [], activeCam, onNavigate, onClose }) {
  const v1 = useRef(null);
  const v2 = useRef(null);
  const v3 = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(2); // fallback

  const cameras = [
    { id: 'source', label: 'SOURCE', ref: v1 },
    { id: 'sink', label: 'SINK', ref: v2 },
    { id: 'hq', label: 'HQ', ref: v3 }
  ];

  const handlePlayPause = () => {
    const isNowPlaying = !playing;
    cameras.forEach(c => {
      if (c.ref.current) {
        if (isNowPlaying) c.ref.current.play().catch(e => console.log('play error', e));
        else c.ref.current.pause();
      }
    });
    setPlaying(isNowPlaying);
  };

  const currentIndex = events.findIndex(ev => ev.id === event?.id);
  const handlePrev = () => {
    if (currentIndex > 0 && onNavigate) onNavigate(events[currentIndex - 1]);
  };
  const handleNext = () => {
    if (currentIndex < events.length - 1 && onNavigate) onNavigate(events[currentIndex + 1]);
  };

  const handleSeek = (e) => {
    const val = parseFloat(e.target.value);
    setProgress(val);
    cameras.forEach(c => {
      if (c.ref.current) c.ref.current.currentTime = val;
    });
  };

  useEffect(() => {
    // Reset when event changes
    setPlaying(false);
    setProgress(0);
  }, [event]);

  if (!event) return null;

  return (
    <div style={{
      position: 'absolute', bottom: '120px', left: '20px', right: '20px',
      background: 'rgba(20,20,20,0.95)', border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: '12px', padding: '16px', backdropFilter: 'blur(10px)',
      boxShadow: '0 10px 40px rgba(0,0,0,0.5)', zIndex: 50,
      animation: 'slideUp 0.3s ease-out'
    }}>
      <style>{`
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ color: 'var(--amber, #f5a623)', fontWeight: 'bold', fontSize: '18px' }}>Event {event.id}</span>
          <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '14px', fontFamily: 'monospace' }}>
            {activeCam.toUpperCase()} Frame: {event.frames ? event.frames[activeCam] : 'N/A'}
          </span>
          <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '12px', fontFamily: 'monospace' }}>
            (HQ Frame: {event.hq_frame})
          </span>
        </div>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '20px' }}>✕</button>
      </div>

      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
        {cameras.map(cam => {
          // clip format is bounce_{bounce_frame}_{flight_id:05d}.mp4
          // located in /clips/{cam.id}/
          const flightIdStr = String(event.metadata.flight_id).padStart(5, '0');
          const bounceFrame = event.metadata.bounce_frame;
          const clipUrl = `http://localhost:8000/clips/${cam.id}/bounce_${bounceFrame}_${flightIdStr}.mp4`;

          return (
            <div key={cam.id} style={{ flex: 1, background: '#000', borderRadius: '8px', overflow: 'hidden', position: 'relative' }}>
              <div style={{ position: 'absolute', top: 8, left: 8, background: 'rgba(0,0,0,0.6)', padding: '4px 8px', fontSize: '12px', color: '#fff', borderRadius: '4px', zIndex: 2 }}>
                {cam.label}
              </div>
              <video
                ref={cam.ref}
                src={clipUrl}
                muted={cam.id !== 'hq'}
                playsInline
                onTimeUpdate={(e) => {
                  if (cam.id === 'hq') {
                    setProgress(e.target.currentTime);
                    if (e.target.currentTime >= e.target.duration) setPlaying(false);
                  }
                }}
                onLoadedMetadata={(e) => {
                  if (cam.id === 'hq') setDuration(e.target.duration || 2);
                }}
                style={{ width: '100%', aspectRatio: '16/9', objectFit: 'contain' }}
              />
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <button onClick={handlePrev} disabled={currentIndex <= 0} style={{
          background: 'rgba(255,255,255,0.1)', color: currentIndex <= 0 ? 'rgba(255,255,255,0.2)' : '#fff', border: 'none',
          padding: '8px 16px', borderRadius: '4px', cursor: currentIndex <= 0 ? 'default' : 'pointer', fontWeight: 'bold'
        }}>
          PREV
        </button>
        <button onClick={handlePlayPause} style={{
          background: 'var(--amber, #f5a623)', color: '#000', border: 'none',
          width: '40px', height: '40px', borderRadius: '50%', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          {playing ? '⏸' : '▶'}
        </button>
        <button onClick={handleNext} disabled={currentIndex >= events.length - 1 || currentIndex === -1} style={{
          background: 'rgba(255,255,255,0.1)', color: (currentIndex >= events.length - 1 || currentIndex === -1) ? 'rgba(255,255,255,0.2)' : '#fff', border: 'none',
          padding: '8px 16px', borderRadius: '4px', cursor: (currentIndex >= events.length - 1 || currentIndex === -1) ? 'default' : 'pointer', fontWeight: 'bold'
        }}>
          NEXT
        </button>
        <input
          type="range" min="0" max={duration} step="0.01" value={progress}
          onChange={handleSeek}
          style={{ flex: 1, cursor: 'pointer' }}
        />
      </div>
    </div>
  );
}
