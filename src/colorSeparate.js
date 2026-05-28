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

// 4-connected flood fill on a Uint8Array channel (255 = background/empty).
// Returns an array of components, each as a Uint8Array with the same dimensions,
// sorted largest-first by pixel count.
export function splitComponents(channel, width, height) {
  const size = width * height;
  const visited = new Uint8Array(size); // 0=unvisited
  const components = [];

  for (let start = 0; start < size; start++) {
    if (channel[start] === 255 || visited[start]) continue;

    // BFS flood fill
    const pixels = [];
    const queue = [start];
    visited[start] = 1;

    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      pixels.push(idx);

      const x = idx % width;
      const y = (idx / width) | 0;

      // 4-connected neighbors
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

  // Sort largest component first
  components.sort((a, b) => b.length - a.length);
  return components;
}

// Given a channel and component pixel lists, merge components into at most `maxSplits`
// separate Uint8Arrays. Largest components get their own slice; the rest are merged.
export function splitChannelIntoSlices(channel, width, height, maxSplits) {
  if (maxSplits <= 1) return [channel];

  const components = splitComponents(channel, width, height);
  if (components.length <= 1) return [channel];

  const size = width * height;
  const numSlices = Math.min(maxSplits, components.length);
  const slices = Array.from({ length: numSlices }, () => new Uint8Array(size).fill(255));

  // Each of the first (numSlices-1) largest components gets its own slice.
  // All remaining components are merged into the last slice.
  for (let s = 0; s < numSlices - 1; s++) {
    for (const idx of components[s]) {
      slices[s][idx] = channel[idx];
    }
  }
  for (let c = numSlices - 1; c < components.length; c++) {
    for (const idx of components[c]) {
      slices[numSlices - 1][idx] = channel[idx];
    }
  }

  return slices;
}
