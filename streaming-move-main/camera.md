# Camera Tuning TODO (Raspberry Pi 4B)

Based on RP-009070 Camera Algorithm and Tuning Guide. Colour correction and lens shading happen on the Pi ISP at capture time — not in the browser player.

**Official tool:** Raspberry Pi Camera Tuning Tool (CTT) — `pip install rpi-ctt` or `utils/raspberrypi/ctt/` in libcamera. Sometimes referred to as libcamera calib. Use **`--alsc-only`** to generate a lens shading JSON without Macbeth charts.

---

## 0. Lens shading JSON (ALSC-only) — priority

Goal: use official CTT to map and eliminate edge vignetting / colour shading in software via `rpi.alsc` in a tuning JSON.

### Capture flat-field DNGs (no Macbeth chart needed)

- [ ] Use uncalibrated tuning file while capturing (`vc4/data/uncalibrated.json`, `"target": "bcm2835"`)
- [ ] Point camera at uniform flat surface (diffused LED panel, grey card + diffuser, or integrating sphere)
- [ ] Capture raw DNGs with `rpicam-still -r -o image.jpg`
- [ ] Filename **must** contain `alsc` + colour temperature, e.g.:
  - `alsc_3000k_1.dng`, `alsc_3000k_1u.dng` (upside-down pair)
  - `alsc_3850k_1.dng`, `alsc_3850k_2.dng` (different positions on light)
- [ ] Capture at 2–3 colour temperatures matching court lighting (e.g. 3000K, 4000K, 6000K)
- [ ] Per temperature: 2–4 images with camera rotated / repositioned (CTT averages to remove uneven illumination)
- [ ] All `.dng` files in one folder root — no subfolders, no JPEGs

### Run CTT — lens calib JSON only

- [ ] Install: `pip install rpi-ctt` (Python 3.11+) on Pi or dev machine
- [ ] ALSC-only (no Macbeth images required):

```bash
python3 -m ctt --alsc-only -i /path/to/alsc_images -o /path/to/output -t vc4 --name imx219
```

- [ ] Or update existing tuning file in place (keeps all other blocks, replaces `rpi.alsc` only):

```bash
python3 -m ctt --alsc-only -i /path/to/alsc_images --update /path/to/existing.json
```

- [ ] Legacy (in libcamera repo): `./alsc_only.py -t vc4 -i /path/to/alsc-images -o alsc.json`

### Output — what goes in the JSON (`rpi.alsc` block)

- [ ] `calibrations_Cr` — per-colour-temperature red shading tables (16×12 grid on Pi 4)
- [ ] `calibrations_Cb` — per-colour-temperature blue shading tables
- [ ] `luminance_lut` — single luminance vignette table (averaged across all ALSC images)
- [ ] `luminance_strength` — how much vignette correction to apply (0.0–1.0; use **1.0** for fully flat edges)
- [ ] `n_iter` — adaptive ALSC iterations (set **0** for fixed court lighting — static table only, no runtime adaptation)

### Merge & deploy lens calib JSON

- [ ] Do **not** use ALSC-only output alone — merge `rpi.alsc` block into full tuning file (e.g. copy from `uncalibrated.json` + paste ALSC block)
- [ ] Or use `--update` flag to merge automatically
- [ ] Deploy to Pi: `/usr/share/libcamera/ipa/rpi/vc4/<sensor>.json` (back up original first)
- [ ] Test with: `rpicam-still -t 0 --tuning-file /path/to/tuning.json`
- [ ] Repeat per camera if lenses differ (source / sink / hq)

### Tune for fixed court lighting

- [ ] Set `"luminance_strength": 1.0` — full edge vignette removal
- [ ] Set `"n_iter": 0` — disable adaptive ALSC; use static calibration tables only
- [ ] If colours at edges still drift, re-capture ALSC images at actual venue colour temperature

### Optional: CTT web UI on Pi

- [ ] `pip install "rpi-ctt[server]"` → `ctt-server` (HTTPS :5000) for capture, tag, and ALSC-only tuning from browser

---

## 1. Identify hardware & baseline

- [ ] Confirm camera module on each Pi 4B (e.g. imx477, imx219, ov5647)
- [ ] Confirm libcamera / rpicam-apps installed on each Pi
- [ ] Copy baseline tuning file from libcamera `vc4/data/uncalibrated.json` (or sensor-specific JSON if it exists)
- [ ] Set `"target": "bcm2835"` in tuning JSON (Pi 4 — not `pisp`)
- [ ] Set correct `rpi.black_level` from sensor datasheet (scaled to 16-bit range)

---

## 2. Capture calibration images (for CTT)

### Macbeth chart (colour / AWB / CCM)

- [ ] Capture raw DNG images with Macbeth chart under multiple colour temperatures (e.g. ~2800K indoor, ~4000K, ~6500K daylight)
- [ ] Record shutter speed, analogue gain, measured lux, and colour temperature per capture (colorimeter or phone approximation)
- [ ] Use uncalibrated tuning file during capture

### Flat-field images (lens shading / ALSC)

- [ ] Capture uniform flat-field raw images (diffused LED panel or integrating sphere)
- [ ] Capture at same colour temperatures as Macbeth set (CTT averages multiple images per temperature)
- [ ] Ensure full sensor field of view is evenly lit

---

## 3. Run Camera Tuning Tool (CTT) — full calibration

- [ ] Install: `pip install rpi-ctt` (or legacy deps: numpy, scipy, opencv, rawpy, pyexiv2 from libcamera `utils/raspberrypi/ctt/`)
- [ ] Place all calibration images in one folder with correct naming (per CTT docs, chapter 6)
- [ ] Full run (Macbeth + ALSC):

```bash
python3 -m ctt -i /path/to/images -o /path/to/output -t vc4 --name <sensor>
```

- [ ] Run CTT → generate full camera tuning JSON
- [ ] Review output for:
  - [ ] `rpi.ccm` — multiple colour-temperature matrices (`ct` + 3×3 `ccm`)
  - [ ] `rpi.alsc` — `calibrations_Cr`, `calibrations_Cb`, `luminance_lut`
  - [ ] `rpi.lux` — reference shutter, gain, Y, lux
  - [ ] `rpi.awb` — CT curve / illuminant calibration
  - [ ] `rpi.agc` — metering modes, `y_target`, exposure modes

---

## 4. Tune ALSC (lens shading)

- [ ] Verify colour shading tables (`calibrations_Cr` / `calibrations_Cb`) per colour temperature
- [ ] Set `luminance_strength` (0 = no vignette fix, 1 = full; often 0.5–1.0 is enough)
- [ ] Confirm adaptive ALSC is active (default `rpi.alsc` behaviour — runs every ~12 frames)
- [ ] Check edges for cyan/magenta cast under actual court lighting; re-capture flat fields if needed

---

## 5. Tune CCM (colour correction matrices)

- [ ] Ensure multiple `ct` entries in `rpi.ccm` (not just one 4000K matrix)
- [ ] Verify AWB → CCM chain: `rpi.awb` listed before `rpi.ccm` in JSON
- [ ] Add `rpi.lux` before CCM if using lux-dependent saturation
- [ ] Validate colours on court surface, lines, and ball under venue lighting

---

## 6. Tune AGC (exposure / metering)

- [ ] Configure centre-weighted metering weights in `rpi.agc` (15-region grid)
- [ ] Set `y_target` piecewise linear curve for target brightness vs lux
- [ ] Choose exposure mode (`normal` / `short` / `long`) for video frame rate constraints
- [ ] Test under bright and dim court conditions

---

## 7. Deploy per camera

- [ ] Install generated JSON as `vc4/data/<sensor_name>.json` on each Pi (or custom path libcamera loads)
- [ ] Repeat CTT per camera module if sensor/lens units differ significantly
- [ ] Verify all three cameras (source, sink, hq) produce consistent colour across views

---

## 8. Validate end-to-end

- [ ] Capture test HLS stream with tuned JSON active
- [ ] Compare colours across source / sink / hq in live and review modes
- [ ] Check bounce detection / CV accuracy improves with correct colours (if downstream CV uses these streams)
- [ ] Document final tuning file version and calibration conditions (date, lighting, equipment)

---

## Reference

- PDF: `player/src/utils/RP-009070-TC-2-Camera Algorithm and Tuning Guide copy.pdf`
- CTT (official): https://github.com/raspberrypi/ctt — `pip install rpi-ctt`
- Lens shading only: PDF section **6.8**, CTT `--alsc-only`
- Key algorithms: `rpi.alsc`, `rpi.ccm`, `rpi.awb`, `rpi.agc`, `rpi.lux`
- Pi 4 pipeline order: Black Level → DPC → Lux → Noise → GEQ → SDN → AWB → AGC → ALSC → Contrast → CCM → Sharpen
- Minimal example JSON: section 4.6.1 (pages 13–14 of PDF)
- Tuning file location on Pi: `/usr/share/libcamera/ipa/rpi/vc4/<sensor>.json`
