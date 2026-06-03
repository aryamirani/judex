import { videoPixelToOverlay } from '../utils/bounceLandingDetect.js'

export default function BounceLandingOverlay({ videoRef, result, visible }) {
  if (!visible || !result || result.pixelX == null || result.pixelY == null || !videoRef?.current) {
    return null
  }

  const pos = videoPixelToOverlay(videoRef.current, result.pixelX, result.pixelY)
  if (!pos) return null

  const r = pos.radius
  return (
    <div
      style={{
        position: 'absolute',
        left: pos.left - r,
        top: pos.top - r,
        width: r * 2,
        height: r * 2,
        borderRadius: '50%',
        border: '3px solid rgba(255, 60, 60, 0.95)',
        boxShadow: '0 0 18px 6px rgba(255, 60, 60, 0.55), inset 0 0 12px rgba(0,0,0,0.35)',
        background: 'rgba(255, 80, 80, 0.22)',
        pointerEvents: 'none',
        zIndex: 5,
        transition: 'opacity 0.15s ease',
      }}
      title="Detected bounce landing"
    />
  )
}
