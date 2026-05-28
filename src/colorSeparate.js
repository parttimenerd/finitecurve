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

function hexToRGB(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Perceptual color distance in Lab-ish space (fast approximation using weighted RGB).
function colorDistSq(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  // CIE76-approximation weighting
  const rmean = (r1 + r2) / 2;
  return (2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db;
}

// For each pixel, assign to nearest-hue thread (by hue angle distance in HSL).
// Achromatic pixels (saturation < 0.15) go to the thread with lowest luminance.
// Pixels close to bgHex (within perceptual threshold) are treated as background → 255.
// Returns N Uint8Arrays, each containing luminance for assigned pixels, 255 elsewhere.
export function separateColors(rgbaData, width, height, threadColors, bgHex) {
  const n = threadColors.length;
  const channels = Array.from({ length: n }, () => new Uint8Array(width * height).fill(255));

  const threadHSL = threadColors.map(c => hexToHSL(c.hex));
  let darkestIdx = 0;
  for (let i = 1; i < n; i++) {
    if (threadHSL[i][2] < threadHSL[darkestIdx][2]) darkestIdx = i;
  }

  // Background suppression: pixels within this perceptual distance² of bgColor are skipped.
  // Threshold corresponds to ~roughly 20/255 per channel.
  const bgRGB = bgHex ? hexToRGB(bgHex) : null;
  const BG_THRESHOLD_SQ = 1800; // ≈ perceptual distance of ~20 units

  for (let i = 0; i < width * height; i++) {
    const r = rgbaData[i * 4];
    const g = rgbaData[i * 4 + 1];
    const b = rgbaData[i * 4 + 2];
    const a = rgbaData[i * 4 + 3];
    if (a < 128) continue;

    // Skip pixels that are perceptually close to the background color
    if (bgRGB) {
      const d = colorDistSq(r, g, b, bgRGB[0], bgRGB[1], bgRGB[2]);
      if (d < BG_THRESHOLD_SQ) continue;
    }

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

// 4-connected BFS flood fill. Returns array of component pixel-index arrays,
// sorted largest-first. Pixels with value 255 are treated as background.
export function splitComponents(channel, width, height) {
  const size = width * height;
  const visited = new Uint8Array(size);
  const components = [];

  for (let start = 0; start < size; start++) {
    if (channel[start] === 255 || visited[start]) continue;

    const pixels = [];
    const queue = [start];
    visited[start] = 1;
    let head = 0;

    while (head < queue.length) {
      const idx = queue[head++];
      pixels.push(idx);
      const x = idx % width;
      const y = (idx / width) | 0;

      if (x > 0 && !visited[idx - 1] && channel[idx - 1] !== 255) {
        visited[idx - 1] = 1; queue.push(idx - 1);
      }
      if (x < width - 1 && !visited[idx + 1] && channel[idx + 1] !== 255) {
        visited[idx + 1] = 1; queue.push(idx + 1);
      }
      if (y > 0 && !visited[idx - width] && channel[idx - width] !== 255) {
        visited[idx - width] = 1; queue.push(idx - width);
      }
      if (y < height - 1 && !visited[idx + width] && channel[idx + width] !== 255) {
        visited[idx + width] = 1; queue.push(idx + width);
      }
    }

    components.push(pixels);
  }

  components.sort((a, b) => b.length - a.length);
  return components;
}

// Split a channel into up to `maxSlices` Uint8Arrays using a smarter strategy:
// 1. Find all connected components, sorted largest-first.
// 2. Small components (< minFraction of the largest) are folded into the nearest
//    large component's slice based on centroid distance — never left as orphans.
// 3. The remaining significant components are grouped greedily into `maxSlices` bins
//    so that each bin's total pixel count is as equal as possible (bin-packing).
//
// Returns array of Uint8Arrays (length ≤ maxSlices, ≥ 1).
export function splitChannelIntoSlices(channel, width, height, maxSlices) {
  if (maxSlices <= 1) return [channel];

  const components = splitComponents(channel, width, height);
  if (components.length <= 1) return [channel];

  const totalPixels = components.reduce((s, c) => s + c.length, 0);
  if (totalPixels === 0) return [channel];

  // Threshold: components smaller than 1% of total are considered "dust"
  const dustThreshold = Math.max(4, totalPixels * 0.01);

  // Separate significant components from dust
  const significant = components.filter(c => c.length >= dustThreshold);
  const dust = components.filter(c => c.length < dustThreshold);

  if (significant.length === 0) return [channel];

  // Compute centroids for significant components (for dust assignment)
  const centroids = significant.map(comp => {
    let sx = 0, sy = 0;
    for (const idx of comp) { sx += idx % width; sy += (idx / width) | 0; }
    return [sx / comp.length, sy / comp.length];
  });

  // Greedy bin-packing: assign significant components to bins to balance pixel count.
  // Start with one bin per component, merge smallest bins while we exceed maxSlices.
  const numBins = Math.min(maxSlices, significant.length);
  // Each bin = list of component indices
  const bins = significant.map((_, i) => [i]);

  while (bins.length > numBins) {
    // Find the two bins whose merge produces the smallest combined size
    let bestMerge = null, bestSize = Infinity;
    for (let a = 0; a < bins.length; a++) {
      for (let b = a + 1; b < bins.length; b++) {
        const sz = bins[a].reduce((s, i) => s + significant[i].length, 0)
                 + bins[b].reduce((s, i) => s + significant[i].length, 0);
        if (sz < bestSize) { bestSize = sz; bestMerge = [a, b]; }
      }
    }
    const [a, b] = bestMerge;
    bins[a] = [...bins[a], ...bins[b]];
    bins.splice(b, 1);
  }

  const size = width * height;
  const slices = Array.from({ length: bins.length }, () => new Uint8Array(size).fill(255));

  // Fill significant component pixels into their bin's slice
  for (let s = 0; s < bins.length; s++) {
    for (const ci of bins[s]) {
      for (const idx of significant[ci]) {
        slices[s][idx] = channel[idx];
      }
    }
  }

  // Assign dust to the nearest significant-component centroid's slice
  for (const dustComp of dust) {
    // Use centroid of the dust component
    let dsx = 0, dsy = 0;
    for (const idx of dustComp) { dsx += idx % width; dsy += (idx / width) | 0; }
    const dcx = dsx / dustComp.length, dcy = dsy / dustComp.length;

    // Find nearest significant centroid
    let nearest = 0, nearestDist = Infinity;
    for (let ci = 0; ci < centroids.length; ci++) {
      const dx = dcx - centroids[ci][0], dy = dcy - centroids[ci][1];
      const d = dx * dx + dy * dy;
      if (d < nearestDist) { nearestDist = d; nearest = ci; }
    }

    // Find which bin owns the nearest significant component
    const ownerBin = bins.findIndex(b => b.includes(nearest));
    if (ownerBin >= 0) {
      for (const idx of dustComp) slices[ownerBin][idx] = channel[idx];
    }
  }

  return slices;
}

// Compute the actual thread plan given colors, their channels, and total thread budget.
// Returns [{hex, colorIndex, sliceIndex, totalSlices, pixelCount}], sorted by
// embroidery order (color order preserved, slices within a color largest-first).
export function computeThreadPlan(colors, channels, width, height, totalThreads) {
  const n = colors.length;

  // Count significant components per color (determines how many splits are useful)
  const componentCounts = channels.map(ch => {
    const comps = splitComponents(ch, width, height);
    const total = comps.reduce((s, c) => s + c.length, 0);
    const dust = Math.max(4, total * 0.01);
    return comps.filter(c => c.length >= dust).length;
  });

  // Distribute thread budget: each color gets at least 1 slot.
  // Extra slots go to colors with the most components (most to gain from splitting).
  // Capped at the actual number of significant components for that color.
  const extra = Math.max(0, totalThreads - n);
  const slots = new Array(n).fill(1);

  for (let e = 0; e < extra; e++) {
    // Score = remaining useful splits (components not yet covered by current slots)
    let best = -1, bestScore = 0;
    for (let k = 0; k < n; k++) {
      const remaining = componentCounts[k] - slots[k];
      if (remaining > bestScore) { bestScore = remaining; best = k; }
    }
    if (best < 0) break; // all colors fully split, stop
    slots[best]++;
  }

  const plan = [];
  for (let i = 0; i < n; i++) {
    const slices = splitChannelIntoSlices(channels[i], width, height, slots[i]);
    for (let s = 0; s < slices.length; s++) {
      let count = 0;
      for (let j = 0; j < slices[s].length; j++) if (slices[s][j] !== 255) count++;
      plan.push({
        hex: colors[i].hex,
        colorIndex: i,
        sliceIndex: s,
        totalSlices: slices.length,
        pixelCount: count,
        grayscaleChannel: slices[s],
      });
    }
  }

  return plan;
}
