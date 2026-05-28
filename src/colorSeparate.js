function rgbToHSL(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hexToHSL(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return rgbToHSL((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// For each pixel, assign to nearest-hue thread (by hue angle distance in HSL).
// Achromatic pixels (saturation < 0.15) go to the thread with lowest luminance.
// Returns N Uint8Arrays, each containing luminance for assigned pixels, 255 elsewhere.
export function separateColors(rgbaData, width, height, threadColors) {
  const n = threadColors.length;
  const channels = Array.from({ length: n }, () => new Uint8Array(width * height).fill(255));

  // Precompute hue and luminance for each thread color
  const threadHSL = threadColors.map(c => hexToHSL(c.hex));
  // Index of darkest thread (lowest luminance) for achromatic pixels
  let darkestIdx = 0;
  for (let i = 1; i < n; i++) {
    if (threadHSL[i][2] < threadHSL[darkestIdx][2]) darkestIdx = i;
  }

  for (let i = 0; i < width * height; i++) {
    const r = rgbaData[i * 4];
    const g = rgbaData[i * 4 + 1];
    const b = rgbaData[i * 4 + 2];
    const a = rgbaData[i * 4 + 3];
    if (a < 128) continue; // transparent → leave as 255 (white) in all channels

    const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    const [h, s] = rgbToHSL(r, g, b);

    let assigned;
    if (s < 0.15) {
      assigned = darkestIdx;
    } else {
      let best = 0, bestDist = Infinity;
      for (let k = 0; k < n; k++) {
        const d = hueDist(h, threadHSL[k][0]);
        if (d < bestDist) { bestDist = d; best = k; }
      }
      assigned = best;
    }

    channels[assigned][i] = lum;
  }

  return channels;
}
