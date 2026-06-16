import React from 'react';

export default function CameraSelector({ active, onSwitch }) {
  const cameras = [
    { id: 'source', label: 'Cam 1 - SOURCE', color: '#e8e8e8' },
    { id: 'sink', label: 'Cam 2 - SINK', color: '#4a90e2' },
    { id: 'hq', label: 'Cam 3 - HQ', color: '#50e3c2' }
  ];

  return (
    <div style={{
      display: 'flex',
      gap: '8px',
      background: 'rgba(255,255,255,0.05)',
      padding: '4px',
      borderRadius: '8px',
    }}>
      {cameras.map(cam => (
        <button
          key={cam.id}
          onClick={() => onSwitch(cam.id)}
          style={{
            padding: '5px 10px',
            border: 'none',
            background: active === cam.id ? 'rgba(255,255,255,0.1)' : 'transparent',
            color: active === cam.id ? '#fff' : 'rgba(255,255,255,0.5)',
            borderRadius: '6px',
            cursor: 'pointer',
            fontFamily: 'var(--condensed, sans-serif)',
            fontSize: '12px',
            letterSpacing: '0.05em',
            fontWeight: active === cam.id ? 'bold' : 'normal',
            transition: 'all 0.2s',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            whiteSpace: 'nowrap'
          }}
        >
          <div style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: active === cam.id ? cam.color : 'transparent',
            border: `1px solid ${cam.color}`
          }} />
          {cam.label}
        </button>
      ))}
    </div>
  );
}
