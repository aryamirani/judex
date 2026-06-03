/**
 * Bounce landing detection (methods 2 + 3):
 *  - Frame subtraction: motion spikes between consecutive frames
 *  - Contour-lite: centroid of motion blob + trajectory direction change (landing kink)
 */

const DEFAULT_FPS = 30
const SAMPLE_W = 320

function toGray(data, w, h) {
  const gray = new Float32Array(w * h)
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }
  return gray
}

function courtRoiBounds(w, h, roiTopFrac = 0.32) {
  const y0 = Math.floor(h * roiTopFrac)
  return { x0: 0, y0, x1: w, y1: h }
}

function motionScore(prev, curr, w, h, roi) {
  let sum = 0
  let count = 0
  for (let y = roi.y0; y < roi.y1; y++) {
    for (let x = roi.x0; x < roi.x1; x++) {
      const i = y * w + x
      sum += Math.abs(curr[i] - prev[i])
      count++
    }
  }
  return count ? sum / count : 0
}

/** Largest motion-blob centroid from abs-diff threshold (contour proxy). */
function diffCentroid(prev, curr, w, h, roi, threshold) {
  let sumX = 0
  let sumY = 0
  let mass = 0
  for (let y = roi.y0; y < roi.y1; y++) {
    for (let x = roi.x0; x < roi.x1; x++) {
      const i = y * w + x
      const d = Math.abs(curr[i] - prev[i])
      if (d < threshold) continue
      sumX += x
      sumY += y
      mass += 1
    }
  }
  if (mass < 12) return null
  return { x: sumX / mass, y: sumY / mass, mass }
}

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    const t = Math.max(0, Math.min(time, (video.duration || 0) - 0.001))
    if (Math.abs(video.currentTime - t) < 0.0005) {
      resolve()
      return
    }
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      resolve()
    }
    const onError = () => {
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      reject(new Error('video seek failed'))
    }
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('error', onError)
    video.currentTime = t
  })
}

async function captureGrayAt(video, canvas, ctx, time, w, h) {
  await seekVideo(video, time)
  ctx.drawImage(video, 0, 0, w, h)
  const img = ctx.getImageData(0, 0, w, h)
  return toGray(img.data, w, h)
}

function localPeakIndices(values, minProminenceRatio = 0.35) {
  const max = Math.max(...values, 1e-6)
  const thresh = max * minProminenceRatio
  const peaks = []
  for (let i = 1; i < values.length - 1; i++) {
    if (values[i] >= thresh && values[i] >= values[i - 1] && values[i] >= values[i + 1]) {
      peaks.push(i)
    }
  }
  if (peaks.length === 0) {
    let best = 0
    for (let i = 1; i < values.length; i++) {
      if (values[i] > values[best]) best = i
    }
    return [best]
  }
  return peaks
}

/**
 * @param {HTMLVideoElement} video
 * @param {{ fps?: number, roiTopFrac?: number }} opts
 */
export async function analyzeBounceLanding(video, opts = {}) {
  if (!video || !video.videoWidth) {
    await new Promise((resolve, reject) => {
      if (video.readyState >= 2) resolve()
      else {
        video.addEventListener('loadeddata', resolve, { once: true })
        video.addEventListener('error', reject, { once: true })
      }
    })
  }

  const duration = video.duration
  if (!duration || !Number.isFinite(duration)) {
    throw new Error('clip has no duration')
  }

  const fps = opts.fps ?? DEFAULT_FPS
  const frameStep = opts.frameStep ?? 2
  const dt = (1 / fps) * frameStep
  const frameCount = Math.max(2, Math.floor((duration * fps) / frameStep))
  const aspect = video.videoWidth / video.videoHeight
  const w = SAMPLE_W
  const h = Math.max(32, Math.round(SAMPLE_W / aspect))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const roi = courtRoiBounds(w, h, opts.roiTopFrac ?? 0.32)

  const times = []
  const grays = []
  for (let i = 0; i < frameCount; i++) {
    const t = Math.min((i * frameStep) / fps, duration - 0.001)
    times.push(t)
    grays.push(await captureGrayAt(video, canvas, ctx, t, w, h))
  }

  const motion = new Array(frameCount).fill(0)
  for (let i = 1; i < frameCount; i++) {
    motion[i] = motionScore(grays[i - 1], grays[i], w, h, roi)
  }

  const peaks = localPeakIndices(motion)
  const rankedPeaks = [...peaks].sort((a, b) => motion[b] - motion[a])
  const primaryPeak = rankedPeaks[0] ?? motion.indexOf(Math.max(...motion))

  const diffThresholds = []
  for (let i = 1; i < frameCount; i++) {
    let maxD = 0
    for (let y = roi.y0; y < roi.y1; y++) {
      for (let x = roi.x0; x < roi.x1; x++) {
        const d = Math.abs(grays[i][y * w + x] - grays[i - 1][y * w + x])
        if (d > maxD) maxD = d
      }
    }
    diffThresholds.push(Math.max(12, maxD * 0.45))
  }

  const track = []
  for (let i = 1; i < frameCount; i++) {
    const c = diffCentroid(grays[i - 1], grays[i], w, h, roi, diffThresholds[i - 1])
    track.push({ frame: i, time: times[i], centroid: c })
  }

  const refineStart = Math.max(1, primaryPeak - 4)
  const refineEnd = Math.min(frameCount - 1, primaryPeak + 4)
  const seg = track.slice(refineStart - 1, refineEnd)

  let landingFrame = primaryPeak
  let landingCentroid = null
  let method = 'subtraction_peak'

  const valid = seg.filter(t => t.centroid)
  if (valid.length >= 3) {
    for (let i = 1; i < valid.length; i++) {
      const prev = valid[i - 1].centroid
      const curr = valid[i].centroid
      const vy = curr.y - prev.y
      const prevVy = i >= 2 ? valid[i - 1].centroid.y - valid[i - 2].centroid.y : vy
      if (prevVy > 1.2 && vy < -1.2) {
        landingFrame = valid[i].frame
        landingCentroid = curr
        method = 'contour_direction_change'
        break
      }
    }
    if (!landingCentroid) {
      const lowest = valid.reduce((a, b) => (b.centroid.y > a.centroid.y ? b : a))
      landingFrame = lowest.frame
      landingCentroid = lowest.centroid
      method = 'contour_lowest_point'
    }
  } else {
    const tIdx = Math.max(0, primaryPeak - 1)
    landingCentroid = track[tIdx]?.centroid ?? null
  }

  const timeSec = times[landingFrame] ?? primaryPeak * dt
  const scaleX = video.videoWidth / w
  const scaleY = video.videoHeight / h
  const pixelX = landingCentroid ? landingCentroid.x * scaleX : null
  const pixelY = landingCentroid ? landingCentroid.y * scaleY : null

  return {
    timeSec,
    frameIndex: landingFrame * frameStep,
    fps,
    frameStep,
    method,
    motionPeakFrame: primaryPeak,
    pixelX,
    pixelY,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    confidence: landingCentroid ? (method === 'contour_direction_change' ? 0.85 : 0.65) : 0.45,
  }
}

/** Map native video pixel coords to CSS overlay position (object-fit: contain). */
export function videoPixelToOverlay(videoEl, px, py) {
  const vw = videoEl.videoWidth
  const vh = videoEl.videoHeight
  const elW = videoEl.clientWidth
  const elH = videoEl.clientHeight
  if (!vw || !vh || !elW || !elH) return null

  const scale = Math.min(elW / vw, elH / vh)
  const contentW = vw * scale
  const contentH = vh * scale
  const offX = (elW - contentW) / 2
  const offY = (elH - contentH) / 2

  return {
    left: offX + px * scale,
    top: offY + py * scale,
    radius: Math.max(14, Math.min(contentW, contentH) * 0.04),
  }
}
