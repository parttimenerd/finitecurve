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

  const threadHSL = threadColors.map(c => hexToHSL(c.hex));
  let darkestIdx = 0;
  for (let i = 1; i < n; i++) {
    if (threadHSL[i][2] < threadHSL[darkestIdx][2]) darkestIdx = i;
  }

  for (let i = 0; i < width * height; i++) {
    const r = rgbaData[i * 4];
    const g = rgbaData[i * 4 + 1];
    const b = rgbaData[i * 4 + 2];
    const a = rgbaData[i * 4 + 3];
    if (a < 128) continue;

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

// Split a channel into up to `maxSlices` Uint8Arrays.
// Strategy: each significant component gets its own slice. When there are more
// components than slices, we merge the two spatially-closest components (by
// centroid distance) — so merged components are geographically adjacent and
// any connector line the algorithm draws between them will be short.
// Dust (< 1% of total pixels) is assigned to the nearest significant centroid.
//
// Returns array of Uint8Arrays (length ≤ maxSlices, ≥ 1).
export function splitChannelIntoSlices(channel, width, height, maxSlices) {
  if (maxSlices <= 1) return [channel];

  const components = splitComponents(channel, width, height);
  if (components.length <= 1) return [channel];

  const totalPixels = components.reduce((s, c) => s + c.length, 0);
  if (totalPixels === 0) return [channel];

  const dustThreshold = Math.max(4, totalPixels * 0.001);
  const significant = components.filter(c => c.length >= dustThreshold);
  const dust = components.filter(c => c.length < dustThreshold);

  if (significant.length === 0) return [channel];

  // Centroid of each significant component
  function centroid(comp) {
    let sx = 0, sy = 0;
    for (const idx of comp) { sx += idx % width; sy += (idx / width) | 0; }
    return [sx / comp.length, sy / comp.length];
  }

  // Start with one bin per significant component
  const bins = significant.map((comp, i) => ({ indices: [i], cx: centroid(comp)[0], cy: centroid(comp)[1] }));

  // Merge spatially-closest pair of bins until we reach maxSlices
  while (bins.length > Math.min(maxSlices, significant.length)) {
    let bestA = 0, bestB = 1, bestDist = Infinity;
    for (let a = 0; a < bins.length; a++) {
      for (let b = a + 1; b < bins.length; b++) {
        const dx = bins[a].cx - bins[b].cx, dy = bins[a].cy - bins[b].cy;
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; bestA = a; bestB = b; }
      }
    }
    // Merge bestB into bestA; recompute centroid as pixel-weighted average
    const totalA = bins[bestA].indices.reduce((s, i) => s + significant[i].length, 0);
    const totalB = bins[bestB].indices.reduce((s, i) => s + significant[i].length, 0);
    const tot = totalA + totalB;
    bins[bestA] = {
      indices: [...bins[bestA].indices, ...bins[bestB].indices],
      cx: (bins[bestA].cx * totalA + bins[bestB].cx * totalB) / tot,
      cy: (bins[bestA].cy * totalA + bins[bestB].cy * totalB) / tot,
    };
    bins.splice(bestB, 1);
  }

  const size = width * height;
  const slices = Array.from({ length: bins.length }, () => new Uint8Array(size).fill(255));

  for (let s = 0; s < bins.length; s++) {
    for (const ci of bins[s].indices) {
      for (const idx of significant[ci]) {
        slices[s][idx] = channel[idx];
      }
    }
  }

  // Assign dust to the nearest bin centroid
  for (const dustComp of dust) {
    let dsx = 0, dsy = 0;
    for (const idx of dustComp) { dsx += idx % width; dsy += (idx / width) | 0; }
    const dcx = dsx / dustComp.length, dcy = dsy / dustComp.length;

    let nearest = 0, nearestDist = Infinity;
    for (let s = 0; s < bins.length; s++) {
      const dx = dcx - bins[s].cx, dy = dcy - bins[s].cy;
      const d = dx * dx + dy * dy;
      if (d < nearestDist) { nearestDist = d; nearest = s; }
    }
    for (const idx of dustComp) slices[nearest][idx] = channel[idx];
  }

  return slices;
}

// Parse an SVG path d string and return the longest connector jump as
// { x0, y0, x1, y1, lengthSq }. Connector jumps are internal M (moveto) commands
// — the worker emits M instead of L when a tour step exceeds the longhaul threshold,
// so these represent actual jumps between disconnected regions, not stitches.
export function findLongestSegment(d) {
  if (!d) return null;
  let best = null;
  let cx = 0, cy = 0;
  let firstM = true;
  // Tokenize: command letter followed by all numeric tokens until next letter
  const cmdRe = /([MLCc])([\s\S]*?)(?=[MLCc]|$)/g;
  const numRe = /([-\d.]+)/g;
  let m;
  while ((m = cmdRe.exec(d)) !== null) {
    const cmd = m[1];
    const nums = [];
    let n;
    numRe.lastIndex = 0;
    while ((n = numRe.exec(m[2])) !== null) nums.push(parseFloat(n[1]));
    if (cmd === 'M' && nums.length >= 2) {
      const x = nums[0], y = nums[1];
      if (!firstM) {
        const dx = x - cx, dy = y - cy;
        const lsq = dx * dx + dy * dy;
        if (!best || lsq > best.lengthSq) {
          best = { x0: cx, y0: cy, x1: x, y1: y, lengthSq: lsq };
        }
      }
      firstM = false;
      cx = x; cy = y;
    } else if (cmd === 'L' && nums.length >= 2) {
      cx = nums[0]; cy = nums[1];
    } else if (cmd === 'C' && nums.length >= 6) {
      // Cubic bezier: cp1x,cp1y cp2x,cp2y endx,endy — endpoint is last pair
      cx = nums[nums.length - 2]; cy = nums[nums.length - 1];
    }
  }
  return best;
}

// Split a grayscale channel into two channels by flood-filling from each side
// of a connector line. The connector goes from (x0,y0) to (x1,y1) in image
// coordinates. We find the assigned pixel nearest each endpoint and flood-fill
// from there; any pixel reachable from endpoint A goes to channelA, the rest
// (reachable from B or unreachable) go to channelB.
export function splitChannelAtConnector(channel, width, height, x0, y0, x1, y1) {
  const size = width * height;

  // Find all connected components with their centroids, sorted largest-first
  const visited = new Uint8Array(size);
  const comps = [];
  for (let start = 0; start < size; start++) {
    if (channel[start] === 255 || visited[start]) continue;
    const pixels = [];
    const queue = [start];
    visited[start] = 1;
    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      pixels.push(idx);
      const qx = idx % width, qy = (idx / width) | 0;
      if (qx > 0 && !visited[idx-1] && channel[idx-1] !== 255) { visited[idx-1]=1; queue.push(idx-1); }
      if (qx < width-1 && !visited[idx+1] && channel[idx+1] !== 255) { visited[idx+1]=1; queue.push(idx+1); }
      if (qy > 0 && !visited[idx-width] && channel[idx-width] !== 255) { visited[idx-width]=1; queue.push(idx-width); }
      if (qy < height-1 && !visited[idx+width] && channel[idx+width] !== 255) { visited[idx+width]=1; queue.push(idx+width); }
    }
    let sx = 0, sy = 0;
    for (const i of pixels) { sx += i % width; sy += (i / width) | 0; }
    comps.push({ pixels, cx: sx / pixels.length, cy: sy / pixels.length });
  }
  comps.sort((a, b) => b.pixels.length - a.pixels.length);

  if (comps.length < 2) return [channel];

  // Find which component centroid is nearest each connector endpoint
  function nearestComp(px, py) {
    let best = 0, bestDist = Infinity;
    for (let ci = 0; ci < comps.length; ci++) {
      const d = (comps[ci].cx - px) ** 2 + (comps[ci].cy - py) ** 2;
      if (d < bestDist) { bestDist = d; best = ci; }
    }
    return best;
  }

  const idxA = nearestComp(x0, y0);
  const idxB = nearestComp(x1, y1);
  if (idxA === idxB) return [channel];

  // Split: A-side = idxA, B-side = idxB, remaining by proximity to A vs B centroid
  const inA = new Uint8Array(size);
  for (let ci = 0; ci < comps.length; ci++) {
    let side;
    if (ci === idxA) {
      side = true;
    } else if (ci === idxB) {
      side = false;
    } else {
      const dA = (comps[ci].cx - comps[idxA].cx) ** 2 + (comps[ci].cy - comps[idxA].cy) ** 2;
      const dB = (comps[ci].cx - comps[idxB].cx) ** 2 + (comps[ci].cy - comps[idxB].cy) ** 2;
      side = dA <= dB;
    }
    if (side) for (const i of comps[ci].pixels) inA[i] = 1;
  }

  const chA = new Uint8Array(size).fill(255);
  const chB = new Uint8Array(size).fill(255);
  for (let i = 0; i < size; i++) {
    if (channel[i] !== 255) {
      if (inA[i]) chA[i] = channel[i]; else chB[i] = channel[i];
    }
  }
  return [chA, chB];
}
// Returns [{hex, colorIndex, sliceIndex, totalSlices, pixelCount}], sorted by
// embroidery order (color order preserved, slices within a color largest-first).
export function computeThreadPlan(colors, channels, width, height, totalThreads) {
  const n = colors.length;

  // Count significant components per color (determines how many splits are useful).
  // Use a tight threshold (0.1% of pixels or min 4) so small-but-real components
  // are counted and get their own thread slot when budget allows.
  const componentCounts = channels.map(ch => {
    const comps = splitComponents(ch, width, height);
    const total = comps.reduce((s, c) => s + c.length, 0);
    const dust = Math.max(4, total * 0.001);
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
