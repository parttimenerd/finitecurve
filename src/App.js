import React from 'react';
import Button from '@material-ui/core/Button';
import Checkbox from "@material-ui/core/Checkbox";
import Divider from "@material-ui/core/Divider";
import Drawer from "@material-ui/core/Drawer";
import FormControlLabel from "@material-ui/core/FormControlLabel";
import Grid from "@material-ui/core/Grid";
import { makeStyles } from '@material-ui/core/styles';
import { withStyles } from '@material-ui/core/styles';
import Menu from "@material-ui/core/Menu";
import MenuItem from "@material-ui/core/MenuItem";
import Slider from "@material-ui/core/Slider";
import Tooltip from "@material-ui/core/Tooltip";
import Typography from "@material-ui/core/Typography";
import CircularProgress from '@material-ui/core/CircularProgress';

import { MapInteractionCSS } from 'react-map-interaction';
import { ColorPicker } from 'material-ui-color';

import List from "@material-ui/core/List";
import ListItem from "@material-ui/core/ListItem";

import exPig from './examples/pig.jpg';
import exDog from './examples/dog.jpg';
import exWorld from './examples/world.png';

import OneLineClient from './OneLineClient.js';
import { separateColors, applyRegionMask, smartFill, findLongestSegment, splitChannelAtConnector } from './colorSeparate.js';

import './App.css';
window.React = React;

const drawerWidth = 220;

const styles = {
  root: {
    display: 'flex',
    height: '100%',
  },
  drawer: {
    width: drawerWidth,
    flexShrink: 0,
  },
  drawerPaper: {
    width: drawerWidth,
    "overflow-x": "hidden",
  },
  content: {
    flexGrow: 1,
    position: "relative",
    overflow: "hidden",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  },
  lowButton: {
    width: drawerWidth - 40,
    marginLeft: 20,
    marginRight: 20,
    marginTop: 20,
    marginBottom: 0,
  },
  highButton: {
    width: drawerWidth - 40,
    marginLeft: 20,
    marginRight: 20,
    marginTop: 0,
    marginBottom: 20,
  },
  lowHighButton: {
    width: drawerWidth - 40,
    marginLeft: 20,
    marginRight: 20,
    marginTop: 20,
    marginBottom: 20,
  },
  imageSelector: {
    display: "inline-block",
    padding: "25px",
    border: "solid 4px #aaa",
    "border-radius": "25px",
    backgroundColor: "#fff",
  },
  errorBox: {
    display: "inline-block",
    padding: "25px",
    border: "solid 4px #f00",
    "border-radius": "25px",
    backgroundColor: "#fff",
  },
  exampleBox: {
    width: "80px",
    height: "80px",
  },
  toast: {
    position: "absolute",
    top: "0.5em",
    left: "0.5em",
  },
  stats: {
    position: "absolute",
    bottom: "0.5em",
    left: "0.5em",
    fontSize: 12,
    color: "gray",
  },
};

const madeStyles = makeStyles(styles);

// ─── Palette utilities ────────────────────────────────────────────────────────

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

async function decodeImageRGBA(arrayBuffer) {
  const blob = new Blob([arrayBuffer]);
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (e) {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return { rgbaData: imageData.data, width: bitmap.width, height: bitmap.height };
}

function buildSegmentationPreview(rgbaData, width, height, colors, controls) {
  const { whiteCutoff, invert, exposure, contrast, bg } = controls;
  const channels = separateColors(rgbaData, width, height, colors);

  // Precompute per-channel pixel counts for cutoff check (match worker logic)
  const expFactor = exposure === 50 ? 1 : (exposure < 50 ? exposure / 50 : 1 + (exposure - 50) / 50);
  const contrastVal = contrast === 50 ? 1 : (() => {
    const c = (contrast / 100.0 * 512 - 256);
    return 259 * (c + 255) / (255 * (259 - c));
  })();

  function applyLUT(lum) {
    // exposure
    let v = Math.min(255, Math.round(lum * expFactor));
    // contrast
    if (contrast !== 50) {
      v = Math.round(contrastVal * (v - 128) + 128);
      if (v < 0) v = 0;
      if (v > 255) v = 255;
    }
    return v;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(width, height);
  const d = out.data;

  // Parse bg color to RGB
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = bgCanvas.height = 1;
  const bgCtx = bgCanvas.getContext('2d');
  bgCtx.fillStyle = bg === 'white' ? '#ffffff' : (bg === 'black' ? '#000000' : bg);
  bgCtx.fillRect(0, 0, 1, 1);
  const bgPx = bgCtx.getImageData(0, 0, 1, 1).data;

  // Use the exact configured colors, composited lightest→darkest (mirrors SVG luminance sort).
  const luminance = hex => {
    const n = parseInt((hex || '888888').replace('#', ''), 16);
    return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  };
  const colorRGB = colors.map(c => {
    const n = parseInt((c.hex || '#888888').replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  });
  // lightest first so dark threads paint over light ones
  const sortedIndices = colors.map((_, i) => i).sort((a, b) => luminance(colors[b].hex) - luminance(colors[a].hex));

  // Fill background
  for (let i = 0; i < width * height; i++) {
    d[i * 4]     = bgPx[0];
    d[i * 4 + 1] = bgPx[1];
    d[i * 4 + 2] = bgPx[2];
    d[i * 4 + 3] = 255;
  }

  // Layer each color channel over the background
  for (const k of sortedIndices) {
    const [cr, cg, cb] = colorRGB[k];
    const ch = channels[k];
    for (let i = 0; i < width * height; i++) {
      if (ch[i] === 255) continue;
      const adjusted = applyLUT(ch[i]);
      const darkness = invert ? 255 - adjusted : adjusted;
      if (darkness >= whiteCutoff) continue;
      d[i * 4]     = cr;
      d[i * 4 + 1] = cg;
      d[i * 4 + 2] = cb;
      d[i * 4 + 3] = 255;
    }
  }

  ctx.putImageData(out, 0, 0);
  return canvas.toDataURL('image/png');
}

async function suggestPalette(arrayBuffer, n, bgColor, vibrancy = 50) {
  const decoded = await decodeImageRGBA(arrayBuffer);
  if (!decoded) return null;
  const { rgbaData, width, height } = decoded;

  const skipNearWhite = bgColor === 'white' || bgColor === '#ffffff' || bgColor === '#fff';
  const samples = [];
  const stride = 4;
  for (let i = 0; i < width * height; i += stride) {
    const a = rgbaData[i * 4 + 3];
    if (a < 128) continue;
    const r = rgbaData[i * 4], g = rgbaData[i * 4 + 1], b = rgbaData[i * 4 + 2];
    if (skipNearWhite && (0.299 * r + 0.587 * g + 0.114 * b) > 230) continue;
    samples.push([r, g, b]);
  }
  if (samples.length === 0) return null;

  // Convert to perceptual Lab space for clustering so hue differences
  // are weighted as strongly as lightness differences.
  function rgbToLab(r, g, b) {
    let R = r / 255, G = g / 255, B = b / 255;
    R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
    G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
    B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;
    const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1.00000;
    const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = v => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  }

  const labSamples = samples.map(([r, g, b]) => rgbToLab(r, g, b));

  // k-means++ init: pick centroids spread far apart in Lab space
  const distSq = (a, b) => (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;
  let centroids = [labSamples[Math.floor(Math.random() * labSamples.length)]];
  while (centroids.length < n) {
    const dists = labSamples.map(s => Math.min(...centroids.map(c => distSq(s, c))));
    const total = dists.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < dists.length; i++) {
      r -= dists[i];
      if (r <= 0) { centroids.push(labSamples[i]); break; }
    }
    if (centroids.length < n) centroids.push(labSamples[labSamples.length - 1]);
  }

  // k-means in Lab space
  let clusterCounts = new Array(n).fill(0);
  for (let iter = 0; iter < 20; iter++) {
    const sums = Array.from({ length: n }, () => [0, 0, 0, 0]);
    for (const lab of labSamples) {
      let best = 0, bestDist = Infinity;
      for (let k = 0; k < n; k++) {
        const d = distSq(lab, centroids[k]);
        if (d < bestDist) { bestDist = d; best = k; }
      }
      sums[best][0] += lab[0]; sums[best][1] += lab[1]; sums[best][2] += lab[2]; sums[best][3]++;
    }
    const prev = centroids;
    centroids = sums.map(([L, a, b, c], i) => c > 0 ? [L/c, a/c, b/c] : prev[i]);
    clusterCounts = sums.map(s => s[3]);
  }

  // Find dominant centroid (largest cluster)
  const dominantIdx = clusterCounts.reduce((best, c, i) => c > clusterCounts[best] ? i : best, 0);

  // Convert centroids back to RGB, clamping to valid range
  function labToRgb(L, a, b) {
    const fy = (L + 16) / 116, fx = a / 500 + fy, fz = fy - b / 200;
    const x = (fx**3 > 0.008856 ? fx**3 : (fx - 16/116) / 7.787) * 0.95047;
    const y = (fy**3 > 0.008856 ? fy**3 : (fy - 16/116) / 7.787) * 1.00000;
    const z = (fz**3 > 0.008856 ? fz**3 : (fz - 16/116) / 7.787) * 1.08883;
    const toSrgb = v => Math.round(Math.min(255, Math.max(0,
      255 * (v > 0.0031308 ? 1.055 * Math.pow(v, 1/2.4) - 0.055 : 12.92 * v))));
    return [
      toSrgb(x *  3.2406 + y * -1.5372 + z * -0.4986),
      toSrgb(x * -0.9689 + y *  1.8758 + z *  0.0415),
      toSrgb(x *  0.0557 + y * -0.2040 + z *  1.0570),
    ];
  }

  const rgbCentroids = centroids.map(([L, a, b]) => {
    // vibrancy 0..50 = scale 0..1 (desaturate), 50..100 = scale 1..2.5 (boost)
    const scale = vibrancy <= 50 ? vibrancy / 50 : 1 + (vibrancy - 50) / 50 * 1.5;
    return labToRgb(L, a * scale, b * scale);
  });
  const dominantRGB = rgbCentroids[dominantIdx];

  // Sort by luminance darkest first
  rgbCentroids.sort((a, b) => (0.299*a[0]+0.587*a[1]+0.114*a[2]) - (0.299*b[0]+0.587*b[1]+0.114*b[2]));

  // Enforce minimum perceptual distance: merge colors that are too similar
  // by replacing the smaller cluster with the midpoint, then re-sort.
  const MIN_LAB_DIST_SQ = 20 * 20; // ΔE ≈ 20 — clearly distinguishable colors
  const labFinal = rgbCentroids.map(([r, g, b]) => rgbToLab(r, g, b));
  for (let i = 0; i < labFinal.length; i++) {
    for (let j = i + 1; j < labFinal.length; j++) {
      if (distSq(labFinal[i], labFinal[j]) < MIN_LAB_DIST_SQ) {
        // Push j further away from i along the L axis
        const dL = labFinal[j][0] - labFinal[i][0];
        const push = dL >= 0 ? 20 : -20;
        labFinal[j][0] = Math.min(100, Math.max(0, labFinal[j][0] + push));
        rgbCentroids[j] = labToRgb(...labFinal[j]);
      }
    }
  }
  rgbCentroids.sort((a, b) => (0.299*a[0]+0.587*a[1]+0.114*a[2]) - (0.299*b[0]+0.587*b[1]+0.114*b[2]));

  const palette = rgbCentroids.map(([r, g, b]) => ({ hex: rgbToHex(r, g, b) }));

  const domHex = rgbToHex(...dominantRGB);
  const domEntry = palette.find(c => c.hex === domHex);
  if (domEntry) domEntry.suggestDuplicate = true;

  return palette;
}

// ─── State ────────────────────────────────────────────────────────────────────

const uiState = {
  SELECTING: 1,
  PROCESSING: 2,
  VIEWING: 4,
  ERROR: 5,
};

const DEFAULT_COLORS = [
  { hex: '#1a1a2e' },
  { hex: '#16213e' },
  { hex: '#0f3460' },
  { hex: '#e94560' },
  { hex: '#f5a623' },
  { hex: '#d4d4d4' },
];

// ─── App ──────────────────────────────────────────────────────────────────────

class App extends React.Component {
  constructor(props) {
    super(props);
    this._lastDecodedImage = null;
    this._lastImageBuffer = null;
    this._lastColorPaths = null;
    this._lastThreadPlan = null;
    this._buildTimer = null;
    // Iterative connector-removal state
    this._iterThreads = null;   // [{hex, grayscaleChannel, width, height, d}]
    this._iterPending = null;   // Set of indices into _iterThreads that are being built this round
    this.state = {
      lastDraw: 0,
      url: "data:",
      background: "white",
      width: 0,
      height: 0,
      ui: uiState.SELECTING,
      status: "",
      map: { scale: 1, translation: { x: 0, y: 0 } },
      controls: this.getDefaultControls(),
      threadPlan: null,
      originalImageUrl: null,
      showOriginal: false,
      segPreviewUrl: null,
      showSegPreview: false,
      paintMode: false,
      activePaintColor: 0,
      paintTolerance: 40,
      regionMask: null, // Int8Array, -1=auto, 0..n-1=forced
    };
    OneLineClient.onResult = d => this.processResult(this, d);
  }

  componentDidMount() {
  }

  getDefaultControls() {
    return {
      timestamp: Date.now(),
      resolution: 30,
      lineWidth: 4,
      exposure: 50,
      contrast: 50,
      whiteCutoff: 240,
      invert: false,
      edgeStrength: 0,
      maxDensity: 10,
      lockDensity: false,
      multiColor: true,
      numColors: 6,
      vibrancy: 50,
      numThreads: 12,
      fg: "#000000",
      colors: DEFAULT_COLORS.map(c => ({ ...c })),
      bg: "white",
      jitterStrength: 0,
      noiseAmplitude: 0,
      fractalAmplitude: 0,
      controlPointNoise: 0,
      edgeWander: 0,
    };
  }

  openFeedback() {
    window.open("https://github.com/parttimenerd/finitecurve/issues", "_blank");
  }

  getUiStateElement() {
    switch (this.state.ui) {
      case uiState.SELECTING:
        return (
          <ImageSelector
            onImageLoading={e => this.onImageLoading(e)}
            onImageSelected={e => this.onImageSelected(e)}
          />);
      case uiState.PROCESSING:
        return <Spinner>Rendering...</Spinner>;
      case uiState.ERROR:
        return (
          <ErrorMessage onAccept={() => this.openImageSelection()}>
            {this.state.error}
          </ErrorMessage>
        );
      case uiState.VIEWING:
        return <span />;
      default:
        return <span />;
    }
  }

  onImageLoading(event) {
    this.setStatus("Loading...");
  }

  onImageSelected(event) {
    this._lastImageBuffer = event.data;
    this.setStatus("Processing...");

    // Create a stable object URL for the original image (for compare overlay).
    if (this.state.originalImageUrl) URL.revokeObjectURL(this.state.originalImageUrl);
    const originalImageUrl = URL.createObjectURL(new Blob([event.data]));
    this.setState({ originalImageUrl, showOriginal: false, regionMask: null });

    decodeImageRGBA(event.data).then(decoded => {
      this._lastDecodedImage = decoded;
      const { numColors } = this.state.controls;
      return suggestPalette(event.data, numColors, this.state.controls.bg, this.state.controls.vibrancy).then(palette => {
        if (palette) {
          this.setState(
            prev => ({ controls: { ...prev.controls, colors: palette } }),
            () => this.startBuild()
          );
        } else {
          this.startBuild();
        }
      });
    });
  }

  startBuild() {
    if (!this._lastDecodedImage) return;
    this._iterThreads = null;
    this._iterPending = null;
    this.setState({ ui: uiState.PROCESSING, threadPlan: null }, () => {
      const { colors, multiColor, fg, numThreads, ...commonOptions } = this.state.controls;
      const { rgbaData, width, height } = this._lastDecodedImage;

      if (multiColor) {
        const channels = separateColors(rgbaData, width, height, colors);
        if (this.state.regionMask) {
          applyRegionMask(channels, this.state.regionMask, rgbaData, width, height);
        }
        const threads = colors.map((c, i) => ({
          hex: this.toHexColor(c.hex),
          stitchMode: c.stitchMode || 'oneline',
          grayscaleChannel: channels[i],
          width,
          height,
          d: null,
        }));
        this._iterThreads = threads;
        this._iterPending = new Set(threads.map((_, i) => i));
        this._updateThreadPlanUI();
        OneLineClient.buildMulti(threads, commonOptions);
      } else {
        // Single-color: build a plain grayscale channel and use the multi path
        // so image data travels atomically with the build message (no setImage race).
        const grayscaleChannel = new Uint8Array(width * height);
        for (let i = 0; i < width * height; i++) {
          const a = rgbaData[i * 4 + 3];
          grayscaleChannel[i] = a < 128 ? 255
            : Math.round(0.299 * rgbaData[i * 4] + 0.587 * rgbaData[i * 4 + 1] + 0.114 * rgbaData[i * 4 + 2]);
        }
        const threads = [{ hex: this.toHexColor(fg), grayscaleChannel, width, height, d: null }];
        // Don't set _iterThreads — processResult's multiColor branch handles splitting,
        // which we don't want for single-color.
        OneLineClient.buildMulti(threads, commonOptions);
      }
    });
  }

  _updateThreadPlanUI() {
    const threads = this._iterThreads;
    if (!threads) return;
    const plan = threads.map((t, i) => ({
      hex: t.hex,
      colorIndex: i,
      sliceIndex: 0,
      totalSlices: 1,
      pixelCount: null,
    }));
    this.setState({ threadPlan: plan });
  }

  // After round 1 completes: greedily split all worst connectors up to thread budget,
  // then render all resulting threads in a single buildMulti call.
  _splitAllAndRender() {
    const threads = this._iterThreads;
    if (!threads) return false;
    const { numThreads } = this.state.controls;
    if (threads.length >= numThreads) return false;

    const { width, height } = this._lastDecodedImage;
    const { resolution } = this.state.controls;
    const maxDim = Math.round(resolution * 150);
    const workerScale = Math.min(maxDim / width, maxDim / height, 1);
    const invScale = 1 / workerScale;
    const renderedDiag = Math.sqrt(Math.pow(width * workerScale, 2) + Math.pow(height * workerScale, 2));
    const minLenSq = Math.pow(renderedDiag * 0.03, 2);
    const scaleSq = workerScale * workerScale;
    const minFullResPixels = Math.ceil(50 / scaleSq);
    const countPixels = ch => { let n = 0; for (let i = 0; i < ch.length; i++) if (ch[i] !== 255) n++; return n; };

    // Work on a mutable copy; `d` values from round 1 drive split decisions.
    const work = threads.map(t => ({ ...t }));
    const unsplittable = new Set();

    while (work.length < numThreads) {
      let worstIdx = -1, worstLenSq = 0;
      for (let i = 0; i < work.length; i++) {
        if (unsplittable.has(i) || !work[i].d) continue;
        const seg = findLongestSegment(work[i].d);
        if (seg && seg.lengthSq > worstLenSq) { worstLenSq = seg.lengthSq; worstIdx = i; }
      }
      if (worstIdx < 0 || worstLenSq < minLenSq) break;

      const t = work[worstIdx];
      const seg = findLongestSegment(t.d);
      const halves = splitChannelAtConnector(
        t.grayscaleChannel, width, height,
        seg.x0 * invScale, seg.y0 * invScale,
        seg.x1 * invScale, seg.y1 * invScale,
      );

      if (halves.length < 2) { unsplittable.add(worstIdx); continue; }

      const countA = countPixels(halves[0]), countB = countPixels(halves[1]);
      const aOk = countA >= minFullResPixels, bOk = countB >= minFullResPixels;

      if (!aOk && !bOk) { unsplittable.add(worstIdx); continue; }

      if (!aOk || !bOk) {
        // One half is dust — replace with the large half, mark unsplittable so we don't loop.
        work[worstIdx] = { ...t, grayscaleChannel: aOk ? halves[0] : halves[1], d: null };
        unsplittable.add(worstIdx);
        continue;
      }

      work[worstIdx] = { ...t, grayscaleChannel: halves[0], d: null };
      work.push(       { ...t, grayscaleChannel: halves[1], d: null });    }

    const newIndices = new Set();
    for (let i = 0; i < work.length; i++) {
      if (work[i].d === null) newIndices.add(i);
    }

    if (newIndices.size === 0) return false;

    this._iterThreads = work;
    this._iterPending = newIndices;
    this._updateThreadPlanUI();
    this.setState({ ui: uiState.PROCESSING });
    const { colors: _c, multiColor: _m, fg: _f, numThreads: _n, ...commonOptions } = this.state.controls;
    OneLineClient.buildMulti(work, commonOptions);
    return true;
  }

  setStatus(string) {
    this.setState({ status: string });
  }

  changeControls(c) {
    const next = { ...this.state.controls, ...c, timestamp: Date.now() };

    // Abort any in-flight render immediately — a new one will start after debounce.
    if (this.state.ui === uiState.PROCESSING) {
      OneLineClient.cancel();
      this.setState({ ui: uiState.VIEWING });
    }

    // When numColors or vibrancy changes: resize colors array, clamp numThreads, re-suggest palette
    if (('numColors' in c && c.numColors !== this.state.controls.numColors) ||
        ('vibrancy' in c && c.vibrancy !== this.state.controls.vibrancy)) {
      const n = next.numColors;
      const cur = next.colors;
      if (cur.length > n) {
        next.colors = cur.slice(0, n);
      } else if (cur.length < n) {
        const extra = Array.from({ length: n - cur.length }, () => ({ hex: '#888888' }));
        next.colors = [...cur, ...extra];
      }
      if (next.numThreads < n) next.numThreads = n;

      this.setState({ controls: next }, () => {
        if (this._lastImageBuffer) {
          suggestPalette(this._lastImageBuffer, n, next.bg, next.vibrancy).then(palette => {
            if (palette) this.changeControls({ colors: palette });
          });
        }
      });
      return;
    }

    // When numThreads changes: auto-suggest so colors fill the new thread budget
    if ('numThreads' in c && c.numThreads !== this.state.controls.numThreads) {
      this.setState({ controls: next }, () => {
        if (this._lastImageBuffer) {
          const { numColors } = this.state.controls;
          suggestPalette(this._lastImageBuffer, numColors, this.state.controls.bg, this.state.controls.vibrancy).then(palette => {
            if (palette) {
              this.setState(
                prev => ({ controls: { ...prev.controls, colors: palette } }),
                () => this.scheduleBuild(150)
              );
            } else {
              this.scheduleBuild(150);
            }
          });
        }
      });
      return;
    }

    this.setState({ controls: next });

    // Refresh segmentation preview live if it's showing
    if (this.state.showSegPreview && this._lastDecodedImage) {
      const { rgbaData, width, height } = this._lastDecodedImage;
      const url = buildSegmentationPreview(rgbaData, width, height, next.colors, next);
      this.setState({ segPreviewUrl: url });
    }

    // Live stroke-width: recompose SVG instantly from cached paths — no rebuild needed
    if ('lineWidth' in c && this._lastColorPaths && this.state.ui === uiState.VIEWING) {
      this.recomposeSVG(c.lineWidth);
      return;
    }

    if (this.state.ui !== uiState.SELECTING) {
      this.scheduleBuild(200);
    }
  }

  scheduleBuild(delayMs) {
    if (this._buildTimer) clearTimeout(this._buildTimer);
    this._buildTimer = setTimeout(() => {
      this._buildTimer = null;
      this.startBuild();
    }, delayMs);
  }

  recomposeSVG(lineWidth) {
    if (!this._lastColorPaths) return;
    const sw = String(lineWidth);
    const colorPaths = this._lastColorPaths.map(p => ({ ...p, strokeWidth: sw }));
    const svg = OneLineClient.assembleSVG(this.state.width, this.state.height, colorPaths);
    const url = "data:image/svg+xml;charset=utf-8;base64," + btoa(svg);
    this.setState({ url });
  }

  openImageSelection() {
    this.setState({ ui: uiState.SELECTING });
  }

  reorderThreads(from, to) {
    const { threadPlan } = this.state;
    if (!threadPlan || from === to) return;
    const next = [...threadPlan];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    this.setState({ threadPlan: next });

    if (this._lastColorPaths) {
      const paths = [...this._lastColorPaths];
      const [movedPath] = paths.splice(from, 1);
      paths.splice(to, 0, movedPath);
      this._lastColorPaths = paths;
      this.recomposeSVG(this.state.controls.lineWidth);
    }
  }

  autoSuggestPalette() {
    if (!this._lastImageBuffer) return;
    const { numColors, bg, vibrancy } = this.state.controls;
    suggestPalette(this._lastImageBuffer, numColors, bg, vibrancy).then(palette => {
      if (palette) this.changeControls({ colors: palette });
    });
  }

  toggleSegPreview() {
    if (!this._lastDecodedImage) return;
    const next = !this.state.showSegPreview;
    if (next) {
      const { rgbaData, width, height } = this._lastDecodedImage;
      const url = buildSegmentationPreview(rgbaData, width, height, this.state.controls.colors, this.state.controls);
      // If no render has completed yet, set dimensions so the map view works
      if (!this.state.width || !this.state.height) {
        const content = document.getElementById('content');
        const scale = content ? Math.min(content.clientWidth / width, content.clientHeight / height) : 1;
        this.setState({ showSegPreview: true, segPreviewUrl: url, width, height, map: { scale, translation: { x: 0, y: 0 } } });
      } else {
        this.setState({ showSegPreview: true, segPreviewUrl: url });
      }
    } else {
      this.setState({ showSegPreview: false, segPreviewUrl: null });
    }
  }

  downloadFile(name, url) {
    const element = document.createElement("a");
    element.setAttribute("href", url);
    element.setAttribute("download", name);
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  }

  getPngUrl() {
    const canvas = document.createElement("canvas");
    const img = document.createElement("img");
    img.src = this.state.url;
    canvas.width = img.width = this.state.width;
    canvas.height = img.height = this.state.height;
    document.body.appendChild(canvas);
    document.body.appendChild(img);
    const ctx = canvas.getContext("2d");
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = this.toHexColor(this.state.controls.bg);
    ctx.fill();
    ctx.drawImage(img, 0, 0);
    const url = canvas.toDataURL('image/png');
    document.body.removeChild(img);
    document.body.removeChild(canvas);
    return url;
  }

  toHexColor(c) {
    if (typeof c === "string") return c;
    return "#" + c.hex;
  }

  render() {
    const { classes } = this.props;
    const { paintMode, activePaintColor, paintTolerance, regionMask } = this.state;
    return (
      <div className={classes.root}>
        <AppDrawer
          {...this.state.controls}
          threadPlan={this.state.threadPlan}
          onChange={c => this.changeControls(c)}
          onNewImage={() => this.openImageSelection()}
          onDownloadSVG={() => this.downloadFile("finitecurve.svg", this.state.url)}
          onDownloadPNG={() => this.downloadFile("finitecurve.png", this.getPngUrl())}
          onResetParams={() => this.changeControls(this.getDefaultControls())}
          onFeedback={() => this.openFeedback()}
          onAutoSuggest={() => this.autoSuggestPalette()}
          onReorderThreads={(from, to) => this.reorderThreads(from, to)}
          onToggleCompare={() => this.setState(s => ({ showOriginal: !s.showOriginal }))}
          onToggleSegPreview={() => this.toggleSegPreview()}
          canSelect={this.state.ui !== uiState.SELECTING}
          canDownload={this.state.ui === uiState.VIEWING}
          canCompare={!!this.state.originalImageUrl && this.state.ui === uiState.VIEWING}
          canSegPreview={!!this._lastDecodedImage}
          showOriginal={this.state.showOriginal}
          showSegPreview={this.state.showSegPreview}
          paintMode={paintMode}
          activePaintColor={activePaintColor}
          paintTolerance={paintTolerance}
          hasPaintMask={!!(regionMask && regionMask.some(v => v >= 0))}
          canPaint={!!this._lastDecodedImage && this.state.controls.multiColor}
          onTogglePaint={() => this.setState(s => ({ paintMode: !s.paintMode }))}
          onSetActivePaintColor={i => this.setState({ activePaintColor: i })}
          onSetPaintTolerance={t => this.setState({ paintTolerance: t })}
          onClearPaintMask={() => { this.setState({ regionMask: null }); setTimeout(() => this.startBuild(), 0); }}
        />
        <div className={classes.content} id="content" style={{ backgroundColor: this.state.background }}>
          <Typography className={classes.toast}>{this.getToastMessage()}</Typography>
          <Typography className={classes.stats}>{this.getStats()}</Typography>
          {!this.state.showSegPreview && this.getUiStateElement(this.state.ui)}
          <MapInteractionCSS value={this.state.map} onChange={(c) => { if (!paintMode) this.setState({ map: c }); }}>
            <img src={this.state.showSegPreview && this.state.segPreviewUrl ? this.state.segPreviewUrl : this.state.url}
                 width={this.state.width + "px"} height={this.state.height + "px"} alt="" />
            {!this.state.showSegPreview && this.state.showOriginal && this.state.originalImageUrl &&
              <img src={this.state.originalImageUrl} width={this.state.width + "px"} height={this.state.height + "px"} alt="original"
                style={{ position: 'absolute', top: 0, left: 0, opacity: 0.5, pointerEvents: 'none' }} />
            }
            {paintMode && this._lastDecodedImage && (
              <PainterOverlay
                width={this.state.width}
                height={this.state.height}
                imgWidth={this._lastDecodedImage.width}
                imgHeight={this._lastDecodedImage.height}
                rgbaData={this._lastDecodedImage.rgbaData}
                colors={this.state.controls.colors}
                activePaintColor={activePaintColor}
                paintTolerance={paintTolerance}
                regionMask={regionMask}
                onMaskChange={mask => {
                  this.setState({ regionMask: mask });
                  setTimeout(() => this.startBuild(), 0);
                }}
              />
            )}
          </MapInteractionCSS>
        </div>
      </div>
    );
  }

  getToastMessage() {
    if (this.state.ui !== uiState.VIEWING) return "";
    if (this.state.map.translation.x === 0 && this.state.map.translation.y === 0) {
      return "Pan/zoom to view details!";
    }
    return "";
  }

  getStats() {
    if (this.state.ui !== uiState.VIEWING) return "";
    const dist = typeof (this.state.lineLength) === "number" ? this.state.lineLength.toFixed(0) : "?";
    return "Image: " + this.state.width + "x" + this.state.height + "px. Line: " + dist + "px";
  }

  processResult(self, data) {
    if (data.success) {
      const isPartial = data.type === 'partial';
      let svg = data.result;

      if (!this.state.controls.multiColor) {
        const fgHex = this.toHexColor(this.state.controls.fg);
        svg = svg.replace(/stroke='black'/, `stroke='${fgHex}'`);
        const m = svg.match(/\bd='([\s\S]*?)'\s*\/>/);
        if (m) this._lastColorPaths = [{ hex: fgHex, d: m[1].trim() }];
      } else {
        // Build _lastColorPaths from the assembled SVG for recomposeSVG
        const pathRe = /stroke='([^']+)'[^/]*?d='([\s\S]*?)'\s*\/>/g;
        const paths = [];
        let pm;
        // eslint-disable-next-line no-cond-assign
        while ((pm = pathRe.exec(svg)) !== null) paths.push({ hex: pm[1], d: pm[2].trim() });
        if (paths.length > 0) this._lastColorPaths = paths;

        // On final result: use bands[] (indexed by thread) to update _iterThreads directly
        if (!isPartial && this._iterThreads && this._iterPending && data.bands) {
          for (const idx of this._iterPending) {
            this._iterThreads[idx].d = data.bands[idx] || '';
          }
          this._iterPending = null;
          if (this._splitAllAndRender()) return;
        }
      }

      const url = "data:image/svg+xml;charset=utf-8;base64," + btoa(svg);
      this.setImageUrl(url, data.width, data.height, {
        lineLength: data.lineLength,
        background: this.toHexColor(this.state.controls.bg),
      }, isPartial);
    } else {
      this.setState({ ui: uiState.ERROR, error: data.error });
    }
  }

  setImageUrl(url, width, height, other, isPartial) {
    const content = document.getElementById("content");
    const scale = Math.min(
      content.clientWidth / width,
      content.clientHeight / height);
    this.setState({
      url, width, height,
      map: { scale, translation: { x: 0, y: 0 } },
      ...other,
    });
    this.setStatus("");

    if (!isPartial) {
      this.setState({ ui: uiState.VIEWING });
    } else if (this.state.ui !== uiState.PROCESSING) {
      this.setState({ ui: uiState.VIEWING });
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function removeKey(old) {
  const x = { ...old };
  for (let i = 1; i < arguments.length; i++) delete x[arguments[i]];
  return x;
}

// ─── Components ───────────────────────────────────────────────────────────────

function ParameterSlider(props) {
  return (
    <Grid container direction="column" spacing={0}>
      <Grid item>
        <Tooltip title={props.tooltip} arrow>
          <Typography>{props.title}</Typography>
        </Tooltip>
      </Grid>
      <Grid item>
        <Tooltip title={props.tooltip} arrow>
          <Slider
            min={props.min}
            max={props.max}
            value={props.value}
            onChange={(c, newValue) => props.onChange(newValue)}
            aria-labelledby="continuous-slider"
            valueLabelDisplay="auto"
            {...removeKey(props, "title")}
          />
        </Tooltip>
      </Grid>
    </Grid>
  );
}

function ParameterCheckbox(props) {
  return (
    <Grid container direction="column" spacing={0}>
      <Grid item>
        <Tooltip title={props.tooltip} arrow>
          <FormControlLabel control={
            <Checkbox
              color="primary"
              checked={props.value}
              onChange={(c, newValue) => props.onChange(newValue)}
              aria-labelledby="continuous-slider"
              valueLabelDisplay="auto"
              {...removeKey(props, "title")}
            />}
            label={props.title} />
        </Tooltip>
      </Grid>
    </Grid>
  );
}

function hexLuminance(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
}

function ColorPaletteEditor({ colors, numThreads, threadPlan, onChange, onAutoSuggest, onReorderThreads }) {
  const MAX_COLORS = 12;
  const MIN_COLORS = 1;
  const dragIdxRef = React.useRef(null);
  const [dragOver, setDragOver] = React.useState(null);
  const [menuAnchor, setMenuAnchor] = React.useState(null);
  const [menuIndex, setMenuIndex] = React.useState(null);

  const STITCH_MODES = ['oneline', 'satin', 'fill', 'running', 'cross'];
  const modeLabel = m => ({ oneline: 'One-line', satin: 'Satin', fill: 'Fill stitch', running: 'Running stitch', cross: 'Cross-stitch' })[m] || m;
  const modeBadge = m => ({ oneline: '∿', satin: '⋮', fill: '≡', running: '- -', cross: '✕' })[m] || '∿';

  function updateStitchMode(index, mode) {
    onChange(colors.map((c, i) => i === index ? { ...c, stitchMode: mode } : c));
  }

  function addColor() {
    if (colors.length >= MAX_COLORS) return;
    onChange([...colors, { hex: '#888888' }]);
  }

  function removeColor(index) {
    if (colors.length <= MIN_COLORS) return;
    onChange(colors.filter((_, i) => i !== index));
  }

  function updateColor(index, value) {
    const hex = typeof value === 'string' ? value : '#' + value.hex;
    onChange(colors.map((c, i) => i === index ? { ...c, hex } : c));
  }

  function duplicateColor(index) {
    if (colors.length >= MAX_COLORS) return;
    const copy = { ...colors[index], suggestDuplicate: false };
    const next = [...colors];
    next.splice(index + 1, 0, copy);
    onChange(next);
  }

  function sortByLuminance() {
    onChange([...colors].sort((a, b) => hexLuminance(a.hex) - hexLuminance(b.hex)));
  }

  function handleDragStart(e, i) {
    dragIdxRef.current = i;
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragOver(e, i) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(i);
  }

  function handleDrop(e, i) {
    e.preventDefault();
    const from = dragIdxRef.current;
    if (from === null || from === i) { setDragOver(null); return; }
    const next = [...colors];
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved);
    dragIdxRef.current = null;
    setDragOver(null);
    onChange(next);
  }

  function handleDragEnd() {
    dragIdxRef.current = null;
    setDragOver(null);
  }

  const threadDragIdxRef = React.useRef(null);
  const [threadDragOver, setThreadDragOver] = React.useState(null);

  function handleThreadDragStart(e, i) {
    threadDragIdxRef.current = i;
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleThreadDragOver(e, i) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setThreadDragOver(i);
  }

  function handleThreadDrop(e, i) {
    e.preventDefault();
    const from = threadDragIdxRef.current;
    if (from === null || from === i) { setThreadDragOver(null); return; }
    threadDragIdxRef.current = null;
    setThreadDragOver(null);
    onReorderThreads && onReorderThreads(from, i);
  }

  function handleThreadDragEnd() {
    threadDragIdxRef.current = null;
    setThreadDragOver(null);
  }

  // Build the thread view from the last computed plan.
  // While a plan isn't available, show a placeholder based on numThreads.
  const threadRows = threadPlan
    ? threadPlan.map((entry, i) => ({ ...entry, key: i }))
    : Array.from({ length: numThreads }, (_, i) => ({
        key: i,
        hex: colors[i % colors.length]?.hex || '#888',
        colorIndex: i % colors.length,
        sliceIndex: 0,
        totalSlices: 1,
        pixelCount: null,
      }));

  return (
    <div>
      {/* ── Color palette (unique hues) ── */}
      <Typography variant="caption" style={{ display: 'block', marginBottom: 2, color: '#555' }}>Colors (drag to reorder)</Typography>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 4 }}>
        {colors.map((c, i) => (
          <div
            key={i}
            draggable
            onDragStart={e => handleDragStart(e, i)}
            onDragOver={e => handleDragOver(e, i)}
            onDrop={e => handleDrop(e, i)}
            onDragEnd={handleDragEnd}
            onContextMenu={e => { e.preventDefault(); setMenuAnchor(e.currentTarget); setMenuIndex(i); }}
            style={{
              position: 'relative', display: 'inline-flex', flexDirection: 'column',
              alignItems: 'center', cursor: 'grab',
              outline: dragOver === i ? '2px solid #1976d2' : 'none',
              borderRadius: 4,
            }}
          >
            <div style={{ position: 'relative', display: 'inline-flex' }}>
              <ColorPicker value={c.hex} hideTextfield disableAlpha onChange={v => updateColor(i, v)} />
              {colors.length > MIN_COLORS && (
                <span onClick={() => removeColor(i)} style={{
                  position: 'absolute', top: -4, right: -4, cursor: 'pointer',
                  background: '#fff', borderRadius: '50%', fontSize: 9,
                  lineHeight: '13px', width: 13, textAlign: 'center',
                  border: '1px solid #aaa', zIndex: 1, userSelect: 'none',
                }}>x</span>
              )}
              {c.suggestDuplicate && colors.length < MAX_COLORS && (
                <Tooltip title="Dominant color — click to add a second pass" arrow>
                  <span onClick={() => duplicateColor(i)} style={{
                    position: 'absolute', bottom: -4, right: -4, cursor: 'pointer',
                    background: '#ffe066', borderRadius: '50%', fontSize: 9,
                    lineHeight: '13px', width: 13, textAlign: 'center',
                    border: '1px solid #aaa', zIndex: 1, userSelect: 'none',
                  }}>★</span>
                </Tooltip>
              )}
            </div>
            <div style={{ fontSize: 7, textAlign: 'center', lineHeight: 1.2, color: '#666', userSelect: 'none' }}>
              {modeBadge(c.stitchMode || 'oneline')}
            </div>
          </div>
        ))}
        {colors.length < MAX_COLORS && (
          <Button onClick={addColor} style={{ minWidth: 24, padding: '2px 4px', fontSize: 16, lineHeight: 1, alignSelf: 'flex-start' }}>+</Button>
        )}
      </div>
      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
        {STITCH_MODES.map(mode => (
          <MenuItem
            key={mode}
            selected={(colors[menuIndex]?.stitchMode || 'oneline') === mode}
            onClick={() => { updateStitchMode(menuIndex, mode); setMenuAnchor(null); }}
          >
            <span style={{ marginRight: 8, fontSize: 12 }}>{modeBadge(mode)}</span>
            {modeLabel(mode)}
          </MenuItem>
        ))}
      </Menu>

      {/* ── Thread order (actual build passes) ── */}
      <Typography variant="caption" style={{ display: 'block', marginTop: 8, marginBottom: 2, color: '#555' }}>
        Threads ({threadRows.length} passes, drag to reorder)
      </Typography>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
        {threadRows.map((entry, i) => {
          const isMultiSlice = entry.totalSlices > 1;
          return (
            <Tooltip
              key={entry.key}
              arrow
              title={isMultiSlice
                ? `Part ${entry.sliceIndex + 1}/${entry.totalSlices} of this color${entry.pixelCount != null ? ` (${entry.pixelCount.toLocaleString()} px)` : ''}`
                : (entry.pixelCount != null ? `${entry.pixelCount.toLocaleString()} px` : '')}
            >
              <div
                draggable
                onDragStart={e => handleThreadDragStart(e, i)}
                onDragOver={e => handleThreadDragOver(e, i)}
                onDrop={e => handleThreadDrop(e, i)}
                onDragEnd={handleThreadDragEnd}
                style={{
                  width: 18, height: 18, borderRadius: 3,
                  backgroundColor: entry.hex,
                  border: threadDragOver === i
                    ? '2px solid #1976d2'
                    : isMultiSlice ? '2px dashed rgba(0,0,0,0.35)' : '1px solid rgba(0,0,0,0.18)',
                  boxSizing: 'border-box',
                  position: 'relative',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'grab',
                }}>
                {isMultiSlice && (
                  <span style={{ fontSize: 7, color: hexLuminance(entry.hex) > 128 ? '#333' : '#eee', lineHeight: 1, userSelect: 'none' }}>
                    {entry.sliceIndex + 1}
                  </span>
                )}
              </div>
            </Tooltip>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
        <Button size="small" onClick={onAutoSuggest} style={{ fontSize: 10, padding: '2px 6px' }}>Auto-suggest</Button>
        <Tooltip title="Sort darkest first (embroidery order)" arrow>
          <Button size="small" onClick={sortByLuminance} style={{ fontSize: 10, padding: '2px 6px' }}>Sort ↕</Button>
        </Tooltip>
      </div>
    </div>
  );
}

// ─── PainterOverlay ───────────────────────────────────────────────────────────
// Canvas overlay that sits on top of the SVG result. Click or drag to paint
// regions; uses smart flood-fill (stops at color edges in the original image).
// The overlay is positioned absolute at 0,0 on top of the image element.
function PainterOverlay({ width, height, imgWidth, imgHeight, rgbaData, colors, activePaintColor, paintTolerance, regionMask, onMaskChange }) {
  const canvasRef = React.useRef(null);

  // Redraw the overlay canvas from the current regionMask.
  // Canvas DOM dimensions = imgWidth x imgHeight (1:1 with source image pixels).
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, imgWidth, imgHeight);
    if (!regionMask) return;
    const imageData = ctx.createImageData(imgWidth, imgHeight);
    const out = imageData.data;
    for (let i = 0; i < imgWidth * imgHeight; i++) {
      const assignment = regionMask[i];
      if (assignment < 0) continue;
      const hex = colors[assignment]?.hex || '#888888';
      const n = parseInt((typeof hex === 'string' ? hex : '#' + hex.hex).replace('#', ''), 16);
      const oi = i * 4;
      out[oi] = (n >> 16) & 255; out[oi + 1] = (n >> 8) & 255; out[oi + 2] = n & 255; out[oi + 3] = 150;
    }
    ctx.putImageData(imageData, 0, 0);
  }, [regionMask, colors, imgWidth, imgHeight]);

  function handlePaint(e) {
    e.preventDefault();
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    // rect is in CSS display pixels (after MapInteractionCSS transform).
    // canvas.width is in source image pixels. Convert:
    const cssToImg = imgWidth / rect.width;
    const ix = Math.round((e.clientX - rect.left) * cssToImg);
    const iy = Math.round((e.clientY - rect.top) * cssToImg);
    if (ix < 0 || iy < 0 || ix >= imgWidth || iy >= imgHeight) return;

    const isErase = e.button === 2 || e.ctrlKey;
    const filled = smartFill(rgbaData, imgWidth, imgHeight, ix, iy, paintTolerance);
    const newMask = regionMask ? regionMask.slice() : new Int8Array(imgWidth * imgHeight).fill(-1);
    for (let i = 0; i < filled.length; i++) {
      if (filled[i]) newMask[i] = isErase ? -1 : activePaintColor;
    }
    onMaskChange(newMask);
  }

  return (
    <canvas
      ref={canvasRef}
      width={imgWidth}
      height={imgHeight}
      onClick={handlePaint}
      onContextMenu={handlePaint}
      style={{
        position: 'absolute', top: 0, left: 0,
        width: width + 'px', height: height + 'px',
        cursor: 'crosshair',
        zIndex: 10,
      }}
    />
  );
}

function AppDrawer(props) {
  const classes = madeStyles();

  return (
    <Drawer variant="permanent" anchor="left" className={classes.drawer} classes={{ paper: classes.drawerPaper }}>
      <List spacing={0}>
        <ListItem>
          <ParameterSlider min={0} max={100} value={props.resolution} onChange={(e, c) => props.onChange({ resolution: c })} title="Resolution" tooltip="Size of the result" />
        </ListItem>
        <ListItem>
          <ParameterSlider min={0.1} max={16} value={props.lineWidth} onChange={(e, c) => props.onChange({ lineWidth: c })} step={0.1} title="Stroke width" tooltip="How thick the line should be" />
        </ListItem>
        <ListItem>
          <ParameterSlider min={0} max={100} value={props.exposure} onChange={(e, c) => props.onChange({ exposure: c })} title="Exposure" tooltip="Brighten or darken the image before rendering (50 = unchanged)" />
        </ListItem>
        <ListItem>
          <ParameterSlider min={0} max={100} value={props.contrast} onChange={(e, c) => props.onChange({ contrast: c })} title="Contrast" tooltip="The difference in density between black and white areas" />
        </ListItem>
        <ListItem>
          <ParameterSlider min={0} max={255} value={props.whiteCutoff} onChange={(e, c) => props.onChange({ whiteCutoff: c })} title="White cutoff" tooltip="How white an area has to be to not draw in it" />
        </ListItem>
        <ListItem>
          <ParameterSlider min={0} max={100} value={props.edgeStrength} onChange={(e, c) => props.onChange({ edgeStrength: c })} title="Edge strength" tooltip="How much edges attract the line (0 = off)" />
        </ListItem>
        <ListItem>
          <ParameterSlider min={0} max={100} step={1} value={props.jitterStrength} onChange={(e, c) => props.onChange({ jitterStrength: c })} title="Point jitter" tooltip="Randomly offset each point by up to N% of its local spacing — affects path topology" />
        </ListItem>
        <ListItem>
          <ParameterSlider min={0} max={20} step={0.5} value={props.noiseAmplitude} onChange={(e, c) => props.onChange({ noiseAmplitude: c })} title="Path noise" tooltip="Perpendicular displacement of each output point along the path (cosmetic)" />
        </ListItem>
        <ListItem>
          <ParameterSlider min={0} max={10} step={0.5} value={props.fractalAmplitude} onChange={(e, c) => props.onChange({ fractalAmplitude: c })} title="Fractal detail" tooltip="Recursive midpoint displacement on straight segments — adds fine texture (cosmetic)" />
        </ListItem>
        <ListItem>
          <ParameterSlider min={0} max={20} step={0.5} value={props.controlPointNoise} onChange={(e, c) => props.onChange({ controlPointNoise: c })} title="Curve wobble" tooltip="Random noise on Bézier control points — makes curves bulge and wiggle (cosmetic)" />
        </ListItem>
        <ListItem>
          <ParameterSlider min={0} max={100} step={1} value={props.edgeWander} onChange={(e, c) => props.onChange({ edgeWander: c })} title="Edge wander" tooltip="Bias fractal midpoints to follow detected edges — line wanders along contours" />
        </ListItem>
        <ListItem>
          <ParameterSlider min={1} max={30} value={31 - props.maxDensity} onChange={(e, c) => props.onChange({ maxDensity: 31 - c })} title="Density" tooltip="Controls line spacing — lower = denser lines across all brightness areas" />
        </ListItem>
        <ListItem style={{ marginTop: -10 }}>
          <ParameterCheckbox value={props.lockDensity} onChange={(e, c) => props.onChange({ lockDensity: c })} title="Lock density" tooltip="Keep visual fill constant when stroke width changes — density auto-adjusts with line width" />
        </ListItem>
        <ListItem style={{ marginTop: -10 }}>
          <ParameterCheckbox value={props.invert} onChange={(e, c) => props.onChange({ invert: c })} title="Invert image" tooltip="Fill white instead of black" />
        </ListItem>
        <ListItem style={{ marginTop: -10 }}>
          <ParameterCheckbox value={props.multiColor} onChange={(e, c) => props.onChange({ multiColor: c })} title="Multi-color" tooltip="Separate image into color regions, one thread per color" />
        </ListItem>
        {props.multiColor && (
          <>
            <ListItem>
              <ParameterSlider min={1} max={12} value={props.numColors} onChange={(e, c) => props.onChange({ numColors: c })} step={1} title="Colors" tooltip="Number of distinct thread colors — auto-suggested from image" />
              <ParameterSlider min={0} max={100} value={props.vibrancy} onChange={(e, c) => props.onChange({ vibrancy: c })} title="Vibrancy" tooltip="How saturated the auto-suggested colors are (50 = natural, higher = more vivid)" />
            </ListItem>
            <ListItem>
              <ParameterSlider min={props.numColors} max={Math.max(props.numColors * 4, 50)} value={props.numThreads} onChange={(e, c) => props.onChange({ numThreads: c })} step={1} title="Threads" tooltip="Total passes — extra passes split a color's disconnected regions to avoid long connector lines" />
            </ListItem>
          </>
        )}
        <ListItem style={{ marginTop: -10 }}>
          <div style={{ width: '100%' }}>
            {props.multiColor ? (
              <ColorPaletteEditor
                colors={props.colors}
                numThreads={props.numThreads}
                threadPlan={props.threadPlan}
                onChange={colors => props.onChange({ colors })}
                onAutoSuggest={props.onAutoSuggest}
                onReorderThreads={props.onReorderThreads}
              />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <Typography variant="caption" style={{ marginRight: 8 }}>Color</Typography>
                <ColorPicker value={props.fg} hideTextfield disableAlpha onChange={c => props.onChange({ fg: c })} />
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', marginTop: 8 }}>
              <Typography variant="caption" style={{ marginRight: 8 }}>Background</Typography>
              <ColorPicker value={props.bg} hideTextfield disableAlpha onChange={c => props.onChange({ bg: c })} />
            </div>
          </div>
        </ListItem>
        <Button variant="contained" onClick={props.onResetParams} className={classes.highButton}>Reset</Button>
        <Divider />
        <Button variant="contained" color="primary" onClick={props.onNewImage} className={classes.lowButton} disabled={!props.canSelect}>Choose Image</Button>
        <Button variant="contained" color="primary" onClick={props.onDownloadSVG} className={classes.lowButton} disabled={!props.canDownload}>Download SVG</Button>
        <Button variant="contained" color="primary" onClick={props.onDownloadPNG} className={classes.lowHighButton} disabled={!props.canDownload}>Download PNG</Button>
        <Button variant="contained" color={props.showOriginal ? "secondary" : "default"} onClick={props.onToggleCompare} className={classes.lowButton} disabled={!props.canCompare}>{props.showOriginal ? "Hide Original" : "Compare"}</Button>
        <Button variant="contained" color={props.showSegPreview ? "secondary" : "default"} onClick={props.onToggleSegPreview} className={classes.lowButton} disabled={!props.canSegPreview}>{props.showSegPreview ? "Show Render" : "Preview Colors"}</Button>
        <Button variant="contained" color={props.paintMode ? "secondary" : "default"} onClick={props.onTogglePaint} className={classes.lowButton} disabled={!props.canPaint}>{props.paintMode ? "Done Painting" : "Paint Regions"}</Button>
        {props.paintMode && (
          <ListItem style={{ flexDirection: 'column', alignItems: 'flex-start', paddingTop: 4, paddingBottom: 4 }}>
            <Typography variant="caption" style={{ color: '#555', marginBottom: 4 }}>Paint with color (click swatch):</Typography>
            <Typography variant="caption" style={{ color: '#888', fontSize: 9, display: 'block', marginBottom: 4 }}>Left-click = assign · Right-click = erase</Typography>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              {props.colors.map((c, i) => (
                <div
                  key={i}
                  onClick={() => props.onSetActivePaintColor(i)}
                  style={{
                    width: 22, height: 22, borderRadius: 4,
                    backgroundColor: typeof c.hex === 'string' ? c.hex : '#' + c.hex.hex,
                    border: props.activePaintColor === i ? '3px solid #1976d2' : '2px solid rgba(0,0,0,0.2)',
                    boxSizing: 'border-box', cursor: 'pointer',
                  }}
                />
              ))}
            </div>
            <Typography variant="caption" style={{ color: '#555', marginBottom: 2 }}>
              Tolerance: {props.paintTolerance}
            </Typography>
            <Slider
              min={0} max={150} value={props.paintTolerance}
              onChange={(e, v) => props.onSetPaintTolerance(v)}
              style={{ width: drawerWidth - 48 }}
            />
            {props.hasPaintMask && (
              <Button size="small" onClick={props.onClearPaintMask} style={{ marginTop: 4, fontSize: 10 }}>
                Clear All Paint
              </Button>
            )}
          </ListItem>
        )}
        <Divider />
        <Button variant="contained" onClick={props.onFeedback} className={classes.lowButton}>Feedback / Issues</Button>
      </List>
    </Drawer>
  );
}

function loadFromImg(props, event) {
  let xhttp = new XMLHttpRequest();
  xhttp.responseType = "arraybuffer";
  xhttp.onreadystatechange = function () {
    if (this.readyState === 4) {
      if (this.status === 200) {
        onImageSelect(props, xhttp.response);
      } else {
        console.log("Can't load image", xhttp);
      }
    }
  };
  xhttp.open("GET", event.target.src, true);
  xhttp.send();
}

function loadFromFile(props, event) {
  if (event.target.files.length === 0) return;
  const reader = new FileReader();
  reader.onload = e => readerOnLoad(props, e);
  reader.onerror = () => {};
  reader.readAsArrayBuffer(event.target.files[0]);
}

function readerOnLoad(props, event) {
  onImageSelect(props, event.target.result);
}

function onImageSelect(props, arrayBuffer) {
  props.onImageSelected({ data: arrayBuffer });
}

function ImageSelector(props) {
  const classes = madeStyles();
  const onClick = e => { props.onImageLoading(e); loadFromImg(props, e); };
  const onFile = e => { props.onImageLoading(e); loadFromFile(props, e); };
  return (
    <div id="imageSelector" style={{ textAlign: "center", width: "100%", position: "absolute", top: "50%", transform: "translateY(-50%)", zIndex: "1" }}>
      <div className={classes.imageSelector}>
        <div>
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <Typography variant="h5">Try an example</Typography>
            <div style={{ paddingTop: "20px", paddingBottom: "20px" }}>
              <ImageExample onClick={onClick} src={exPig} title="Draw me like one of your French pigs. Oinque." />
              <ImageExample onClick={onClick} src={exWorld} title="Around the world, around the world, around the world, around the world - Daft Punk" />
              <ImageExample onClick={onClick} src={exDog} title="I've heard humans say it's a doggy dog world, and I couldn't agree more." />
            </div>
            <BorderWithText text="or" />
            <div>
              <Typography variant="h5" style={{ paddingTop: "20px", paddingBottom: "20px" }}>Upload your own</Typography>
              <input type="file" id="file" onChange={onFile} accept="image/*" title="The image is processed locally and never uploaded." />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Spinner(props) {
  const classes = madeStyles();
  return (
    <div style={{ textAlign: "center", width: "100%", position: "absolute", top: "50%", transform: "translateY(-50%)", zIndex: "1" }}>
      <div className={classes.imageSelector}>
        <CircularProgress color="primary" style={{ marginTop: 10, marginBottom: 10 }} />
        <Typography>{props.children}</Typography>
      </div>
    </div>
  );
}

function ErrorMessage(props) {
  const classes = madeStyles();
  return (
    <div style={{ textAlign: "center", width: "100%", position: "absolute", top: "50%", transform: "translateY(-50%)", zIndex: "1" }}>
      <div className={classes.errorBox}>
        <Typography>{props.children}</Typography>
        <br />
        <Button variant="contained" color="primary" onClick={props.onAccept}>Ok</Button>
      </div>
    </div>
  );
}

function BorderWithText(props) {
  const borderStyle = { borderBottom: "1px solid #aaa", width: "100%", height: "1px" };
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      <div className="border" style={borderStyle} />
      <span style={{ marginLeft: "0.5em", marginRight: "0.5em", marginTop: "-0.1em" }}>{props.text}</span>
      <div className="border" style={borderStyle} />
    </div>
  );
}

function ImageExample(props) {
  return (
    <Button onClick={props.onClick} style={{ padding: "0px" }}>
      <img src={props.src} style={{ height: "100px" }} alt={props.title} title={props.title} />
    </Button>
  );
}

export default withStyles(styles)(App);
