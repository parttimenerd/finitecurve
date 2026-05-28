'use strict';

// ─── Image ───────────────────────────────────────────────────────────────────

class Image {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.pixels = new Uint8Array(w * h);
  }

  getShade(x, y) {
    return this.pixels[y * this.width + x];
  }

  adjustContrast(percent, whiteCutoff, invert) {
    if (percent === 50) return;
    const contrast = (percent / 100.0 * 512 - 256);
    const factor = 259 * (contrast + 255) / (255 * (259 - contrast));
    for (let i = 0, e = this.pixels.length; i < e; i++) {
      // Skip pixels that are effectively "white" (will be ignored by fillRandom)
      const darkness = invert ? 255 - this.pixels[i] : this.pixels[i];
      if (darkness >= whiteCutoff) continue;
      let v = Math.round(factor * (this.pixels[i] - 128) + 128);
      if (v < 0) v = 0;
      if (v > 255) v = 255;
      this.pixels[i] = v;
    }
  }

  // Load from ArrayBuffer, scale to fit within maxW x maxH, box-filter smooth=1
  static loadBuffer(arrayBuffer, maxW, maxH, smooth, invert) {
    // Decode image via canvas (works in Worker via OffscreenCanvas or ImageBitmap)
    // We receive raw pixel data decoded externally; handled by loadFromPixels.
    // This method is called with already-decoded RGBA data from the main thread.
    throw new Error('Use loadFromRGBA instead');
  }

  static loadFromRGBA(rgba, srcW, srcH, maxW, maxH, smooth, invert) {
    // Determine output size preserving aspect ratio
    const xRatio = maxW / srcW;
    const yRatio = maxH / srcH;
    let w, h;
    if (xRatio < yRatio) {
      w = maxW;
      h = Math.max(1, Math.round(xRatio * srcH));
    } else {
      h = maxH;
      w = Math.max(1, Math.round(yRatio * srcW));
    }

    const img = new Image(w, h);

    // Convert RGBA→greyscale with box filter downscale
    const xScale = srcW / w;
    const yScale = srcH / h;
    const boxW = Math.max(1, Math.round(xScale));
    const boxH = Math.max(1, Math.round(yScale));

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let n = 0, s = 0;
        let transparent = false;
        const py0 = Math.floor(y * yScale);
        const px0 = Math.floor(x * xScale);
        for (let yd = 0; yd < boxH; yd++) {
          const py = py0 + yd;
          if (py >= srcH) break;
          for (let xd = 0; xd < boxW; xd++) {
            const px = px0 + xd;
            if (px >= srcW) break;
            const off = (py * srcW + px) * 4;
            if (rgba[off + 3] === 0) transparent = true;
            s += Math.round(0.299 * rgba[off] + 0.587 * rgba[off + 1] + 0.114 * rgba[off + 2]);
            n++;
          }
        }
        const val = n === 0 ? 0 : Math.round(s / n);
        img.pixels[y * w + x] = transparent ? 255 : (invert ? 255 - val : val);
      }
    }
    return img;
  }
}

// ─── Point ───────────────────────────────────────────────────────────────────

const NO_ID = -1;

class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.visited = 0;
    this.color = 0;
    this.next = NO_ID;
    this.reach = -1;
    this.isPartOfPath = false;
    this.isIgnored = false;
    this.neighbors = [];
    this.shade = 0;
  }

  monotonicDistanceTo(other) {
    const xd = other.x - this.x;
    const yd = other.y - this.y;
    return xd * xd + yd * yd;
  }

  monotonicDistanceToXY(x, y) {
    const xd = x - this.x;
    const yd = y - this.y;
    return xd * xd + yd * yd;
  }

  radiansTo(other) {
    return Math.atan2(other.x - this.x, other.y - this.y);
  }

  isOn(other) {
    return this.x === other.x && this.y === other.y;
  }

  hasNeighbor(id) {
    return this.neighbors.includes(id);
  }

  addNeighbor(id) {
    this.neighbors.push(id);
  }

  removeNeighbor(id) {
    const i = this.neighbors.indexOf(id);
    if (i !== -1) this.neighbors.splice(i, 1);
  }

  usuallyExcluded() {
    return this.isIgnored || this.isPartOfPath;
  }
}

// Segment intersection test (same as C++)
function orientation(p, q, r) {
  const val = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  if (val === 0) return 0;
  return val > 0 ? 1 : 2;
}

function onSegment(p, q, r) {
  return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) &&
    q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
}

function wouldCross(p1, q1, p2, q2) {
  if (p1.isOn(p2) || p1.isOn(q2) || q1.isOn(p2) || q1.isOn(q2)) return false;
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

// ─── Points ──────────────────────────────────────────────────────────────────

class Points {
  constructor(config) {
    this.config = config;
    this.startId = NO_ID;
    this.endId = NO_ID;
    this.hasPath = false;
    this.serial = 1;
    this.resolution = 25;
    this.points = [];
    this.longhauls = [];

    this.bucketWidth = Math.ceil(config.width / this.resolution);
    this.bucketHeight = Math.ceil(config.height / this.resolution);
    const total = this.bucketWidth * this.bucketHeight;
    this.buckets = new Array(total);
    for (let i = 0; i < total; i++) this.buckets[i] = [];
  }

  bucketForCoord(coord) { return Math.floor(coord / this.resolution); }

  getBucketByIndex(xb, yb) {
    if (xb < 0 || yb < 0 || xb >= this.bucketWidth || yb >= this.bucketHeight) return [];
    return this.buckets[yb * this.bucketWidth + xb];
  }

  getBucketFor(x, y) {
    return this.getBucketByIndex(this.bucketForCoord(x), this.bucketForCoord(y));
  }

  addPoint(x, y) {
    const p = new Point(x, y);
    p.reach = this.config.neighborhood;
    const id = this.points.length;
    this.points.push(p);
    this.getBucketFor(x, y).push(id);
    return p;
  }

  isLonghaul(dist) {
    return dist >= this.config.maxReach * this.config.maxReach;
  }

  connectNeighbors(a, b, dist) {
    const ap = this.points.indexOf(a);
    const bp = this.points.indexOf(b);
    a.addNeighbor(bp);
    b.addNeighbor(ap);
    if (this.isLonghaul(dist)) {
      this.longhauls.push(ap < bp ? ap : bp);
    }
  }

  connectNeighborsByIds(ai, bi, dist) {
    const a = this.points[ai], b = this.points[bi];
    a.addNeighbor(bi);
    b.addNeighbor(ai);
    if (this.isLonghaul(dist)) {
      this.longhauls.push(ai < bi ? ai : bi);
    }
  }

  disconnectNeighbors(a, b) {
    const ai = this.points.indexOf(a);
    const bi = this.points.indexOf(b);
    a.removeNeighbor(bi);
    b.removeNeighbor(ai);
  }

  *findPointsWithin(x, y, distance) {
    const monoDist = distance * distance;
    const range = Math.ceil(distance / this.resolution);
    const xb = this.bucketForCoord(x);
    const yb = this.bucketForCoord(y);
    for (let ybd = -range; ybd <= range; ybd++) {
      for (let xbd = -range; xbd <= range; xbd++) {
        const bucket = this.getBucketByIndex(xb + xbd, yb + ybd);
        for (const id of bucket) {
          const p = this.points[id];
          if (p.isIgnored) continue;
          if (p.monotonicDistanceToXY(x, y) < monoDist) yield id;
        }
      }
    }
  }

  hasPointsWithin(x, y, distance) {
    for (const _ of this.findPointsWithin(x, y, distance)) return true;
    return false;
  }

  setEndPoints() {
    const pts = this.points;
    const cfg = this.config;
    // Find the darkest original-image point as start
    // When inverted, stored shade is 255-original, so darkest original = highest stored shade
    const isDarker = cfg.invert
      ? (a, b) => a.shade > b.shade
      : (a, b) => a.shade < b.shade;
    let startId = 0;
    for (let i = 1; i < pts.length; i++) {
      if (isDarker(pts[i], pts[startId])) startId = i;
    }
    // Find the darkest point that is also far from start (at least 1/3 of image diagonal away)
    const minDist2 = (cfg.width * cfg.width + cfg.height * cfg.height) / 9;
    const start = pts[startId];
    let endId = -1;
    let bestShade = cfg.invert ? -Infinity : Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (i === startId) continue;
      if (start.monotonicDistanceTo(pts[i]) < minDist2) continue;
      if (cfg.invert ? pts[i].shade > bestShade : pts[i].shade < bestShade) {
        bestShade = pts[i].shade;
        endId = i;
      }
    }
    // Fallback to leftmost/rightmost if no far-enough dark point found
    if (endId === -1) {
      let leftmost = 0, rightmost = 1;
      for (let i = 0; i < pts.length; i++) {
        if (pts[i].x < pts[leftmost].x) leftmost = i;
        if (pts[i].x > pts[rightmost].x) rightmost = i;
      }
      this.startId = leftmost;
      this.endId = rightmost;
    } else {
      this.startId = startId;
      this.endId = endId;
    }
  }

  fillRandom(image) {
    const cfg = this.config;
    for (let y = 0; y < cfg.height; y++) {
      for (let x = 0; x < cfg.width; x++) {
        const shade = image.getShade(x, y);
        // When inverted, stored shade is 255-original; use original luminance for cutoff/density
        const darkness = cfg.invert ? 255 - shade : shade;
        if (darkness > cfg.whiteCutoff) continue;
        const d = Math.round(darkness * (cfg.pointDensityWhite - cfg.pointDensity) / cfg.whiteCutoff + cfg.pointDensity);
        if (!this.hasPointsWithin(x, y, d)) {
          const p = this.addPoint(x, y);
          p.shade = shade;
          p.reach = Math.round(d * cfg.neighborhood / cfg.pointDensity);
          x += d - 1;
        }
      }
    }
  }

  connectClosePoints() {
    const cfg = this.config;
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      const candidates = [];
      for (const nid of this.findPointsWithin(p.x, p.y, p.reach)) {
        const neighbor = this.points[nid];
        if (p.isOn(neighbor) || p.hasNeighbor(nid)) continue;
        candidates.push([p.monotonicDistanceTo(neighbor), nid]);
      }
      candidates.sort((a, b) => a[0] - b[0]);
      for (const [dist, nid] of candidates) {
        const neighbor = this.points[nid];
        if (p.neighbors.length >= cfg.maxNeighbors) break;
        if (!this.wouldCrossAny(p, neighbor)) {
          this.connectNeighborsByIds(i, nid, dist);
        }
      }
    }
  }

  pruneSimilarAngles() {
    const cfg = this.config;
    for (let i = 0; i < this.points.length; i++) {
      const point = this.points[i];
      if (point.neighbors.length <= 1) continue;

      const angles = point.neighbors.map(n => {
        const neighbor = this.points[n];
        return [point.radiansTo(neighbor), [point.monotonicDistanceTo(neighbor), n]];
      });
      angles.sort((a, b) => a[0] - b[0]);

      // Wrap lowest around
      const lowest = [angles[0][0] + 2 * Math.PI, angles[0][1]];
      angles.push(lowest);

      for (let j = 1; j < angles.length; j++) {
        const diff = angles[j][0] - angles[j - 1][0];
        if (diff < cfg.minRadianDifference) {
          const [distA, nidA] = angles[j][1];
          const [distB, nidB] = angles[j - 1][1];
          if (distA > distB) {
            this.points[i].removeNeighbor(nidA);
            this.points[nidA].removeNeighbor(i);
          } else {
            this.points[i].removeNeighbor(nidB);
            this.points[nidB].removeNeighbor(i);
          }
        }
      }
    }
  }

  trimShortHairs(maxLength) {
    for (let startIdx = 0; startIdx < this.points.length; startIdx++) {
      const point = this.points[startIdx];
      if (point.neighbors.length !== 1) continue;

      let previous = NO_ID;
      let current = startIdx;
      let mayTrim = true;
      const hair = [];

      do {
        hair.push(current);
        if (current === this.startId || current === this.endId || hair.length > maxLength) {
          mayTrim = false;
          break;
        }
        const cur = this.points[current];
        let next = NO_ID;
        for (const c of cur.neighbors) {
          if (c !== previous) { next = c; break; }
        }
        previous = current;
        current = next;
      } while (current !== NO_ID && this.points[current].neighbors.length <= 2);

      if (mayTrim) {
        for (const piece of hair) {
          for (const nb of this.points[piece].neighbors) {
            this.points[nb].removeNeighbor(piece);
          }
          this.points[piece].neighbors = [];
        }
      }
    }
  }

  makeGrid() {
    this.connectClosePoints();
    this.pruneSimilarAngles();
    this.trimShortHairs(this.config.trimHairsShorterThan);
    this.shuffleNeighbors();
  }

  shuffleNeighbors() {
    for (const p of this.points) {
      for (let i = p.neighbors.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [p.neighbors[i], p.neighbors[j]] = [p.neighbors[j], p.neighbors[i]];
      }
    }
  }

  wouldCrossAny(from, to) {
    return this.wouldCrossAnyShort(from, to) || this.wouldCrossLonghauls(from, to);
  }

  wouldCrossAnyShort(from, to) {
    const cfg = this.config;
    for (const cid of this.findPointsWithin(from.x, from.y, cfg.maxReach)) {
      const current = this.points[cid];
      for (let j = 0; j < current.neighbors.length; j++) {
        const nid = current.neighbors[j];
        if (cid < nid) {
          const neighbor = this.points[nid];
          if (neighbor.isIgnored) continue;
          if (wouldCross(from, to, current, neighbor)) return true;
        }
      }
    }
    return false;
  }

  wouldCrossLonghauls(from, to) {
    for (const lid of this.longhauls) {
      const longhaul = this.points[lid];
      for (const nid of longhaul.neighbors) {
        const neighbor = this.points[nid];
        if (neighbor.isIgnored) continue;
        if (wouldCross(from, to, longhaul, neighbor)) return true;
      }
    }
    return false;
  }

  wouldCrossAnyLong(from, to) {
    const cfg = this.config;
    const d2 = from.monotonicDistanceTo(to);
    if (d2 < cfg.maxReach * cfg.maxReach) return this.wouldCrossAny(from, to);
    if (this.wouldCrossLonghauls(from, to)) return true;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const n = Math.ceil(Math.sqrt(d2) / (cfg.maxReach - 2));

    let fakeFrom = { x: from.x, y: from.y, monotonicDistanceTo: () => 0, monotonicDistanceToXY: () => 0, isOn: () => false };
    for (let i = 1; i <= n; i++) {
      const fakeTo = {
        x: from.x + Math.round(dx * i / n),
        y: from.y + Math.round(dy * i / n),
        isOn: (o) => fakeTo.x === o.x && fakeTo.y === o.y,
      };
      const fakeFromObj = { x: fakeFrom.x, y: fakeFrom.y, isOn: (o) => fakeFrom.x === o.x && fakeFrom.y === o.y };
      if (this._wouldCrossAnyShortXY(fakeFromObj, fakeTo)) return true;
      fakeFrom = { x: fakeTo.x, y: fakeTo.y };
    }
    return false;
  }

  _wouldCrossAnyShortXY(from, to) {
    const cfg = this.config;
    for (const cid of this.findPointsWithin(from.x, from.y, cfg.maxReach)) {
      const current = this.points[cid];
      for (const nid of current.neighbors) {
        if (cid < nid) {
          const neighbor = this.points[nid];
          if (neighbor.isIgnored) continue;
          if (wouldCross(from, to, current, neighbor)) return true;
        }
      }
    }
    return false;
  }

  // DFS connect from start to end, marks path
  connect(start, end) {
    const stack = [{ point: start, index: -2 }];
    const serial = this.serial++;

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const point = this.points[top.point];

      if (top.index === -2) {
        if (top.point === end) break;
        if (point.visited === serial || point.usuallyExcluded()) {
          stack.pop();
          continue;
        }
        point.visited = serial;
        top.index = point.neighbors.length - 1;
      } else if (top.index === -1) {
        stack.pop();
      } else {
        const nextPoint = point.neighbors[top.index--];
        stack.push({ point: nextPoint, index: -2 });
      }
    }

    if (stack.length === 0) return false;

    this.points[end].isPartOfPath = true;
    for (let i = 1; i < stack.length; i++) {
      const p = this.points[stack[i - 1].point];
      p.isPartOfPath = true;
      p.next = stack[i].point;
    }
    return true;
  }

  expandPath() {
    let modified = false;
    let modifiedThisIter;
    do {
      let current = this.startId;
      modifiedThisIter = false;
      while (this.points[current].next !== NO_ID) {
        const next = this.points[current].next;
        for (const detour of this.points[current].neighbors) {
          const detourP = this.points[detour];
          if (detourP.isPartOfPath) continue;
          if (this.connect(detour, next)) {
            this.points[current].next = detour;
            modified = modifiedThisIter = true;
            break;
          }
        }
        current = this.points[current].next;
      }
    } while (modifiedThisIter);
    return modified;
  }

  invadeIslands(colorCount) {
    let secondPrevious = NO_ID, previous = NO_ID, current = this.startId;

    while (current !== NO_ID) {
      const currentPoint = this.points[current];
      const next = currentPoint.next;

      for (const nid of currentPoint.neighbors) {
        const neighbor = this.points[nid];
        if (neighbor.usuallyExcluded()) continue;
        const color = neighbor.color;
        if ((colorCount.get(color) || 0) < this.config.minimumGroupSize) continue;

        let prevDist = Infinity;
        if (previous !== NO_ID && !this.points[previous].hasNeighbor(nid) &&
            !this.wouldCrossAnyLong(this.points[previous], neighbor)) {
          prevDist = this.points[previous].monotonicDistanceTo(neighbor);
        }
        let nextDist = Infinity;
        if (next !== NO_ID && !this.points[next].hasNeighbor(nid) &&
            !this.wouldCrossAnyLong(this.points[next], neighbor)) {
          nextDist = this.points[next].monotonicDistanceTo(neighbor);
        }

        if (prevDist === Infinity && nextDist === Infinity) {
          const secondNext = next === NO_ID ? NO_ID : this.points[next].next;
          let from, excluding, to, needsConnect;
          if (secondPrevious !== NO_ID &&
              (this.points[secondPrevious].hasNeighbor(nid) ||
               !this.wouldCrossAnyLong(this.points[secondPrevious], neighbor))) {
            needsConnect = secondPrevious; from = secondPrevious; excluding = previous; to = current;
          } else if (secondNext !== NO_ID &&
              (this.points[secondNext].hasNeighbor(nid) ||
               !this.wouldCrossAnyLong(this.points[secondNext], neighbor))) {
            needsConnect = secondNext; from = current; excluding = next; to = secondNext;
          } else {
            continue;
          }
          if (!this.points[needsConnect].hasNeighbor(nid)) {
            this.connectNeighborsByIds(needsConnect, nid,
              this.points[needsConnect].monotonicDistanceTo(neighbor));
          }
          this.points[from].next = nid;
          neighbor.next = to;
          neighbor.isPartOfPath = true;
          this.points[excluding].isPartOfPath = false;
          this.points[excluding].next = NO_ID;
          return true;
        }

        if (prevDist < nextDist) {
          this.connectNeighborsByIds(previous, nid, prevDist);
          this.points[previous].next = nid;
          neighbor.next = current;
          neighbor.isPartOfPath = true;
        } else {
          this.connectNeighborsByIds(nid, next, nextDist);
          currentPoint.next = nid;
          neighbor.next = next;
          neighbor.isPartOfPath = true;
        }
        return true;
      }

      secondPrevious = previous;
      previous = current;
      current = next;
    }
    return false;
  }

  fillHoles() {
    const lastSeen = new Map(); // nid -> {from, iteration}
    const touched = new Set();
    let iteration = 1;
    const maxReach = 4;
    let currentId = this.startId;
    let changed = false;

    while (currentId !== NO_ID) {
      const current = this.points[currentId];
      for (const n of current.neighbors) {
        if (this.points[n].isPartOfPath) continue;
        if (!lastSeen.has(n)) {
          lastSeen.set(n, { from: currentId, iteration });
        } else {
          const prev = lastSeen.get(n);
          const distance = iteration - prev.iteration;
          if (distance <= maxReach && !touched.has(prev.from)) {
            // Erase previous segment
            let last = prev.from;
            while (last !== currentId) {
              touched.add(last);
              const lastP = this.points[last];
              const nextLast = lastP.next;
              lastP.next = NO_ID;
              lastP.isPartOfPath = false;
              last = nextLast;
            }
            // Add shortcut through n
            this.points[prev.from].next = n;
            this.points[prev.from].isPartOfPath = true;
            this.points[n].next = currentId;
            this.points[n].isPartOfPath = true;
            changed = true;
          }
          lastSeen.delete(n);
        }
      }
      currentId = current.next;
      iteration++;
    }

    if (changed) {
      return this.expandPath();
    }
    return false;
  }

  resetColor() {
    for (const p of this.points) p.color = 0;
  }

  colorGroup(from, color) {
    const stack = [from];
    let count = 0;
    while (stack.length) {
      const id = stack.pop();
      const point = this.points[id];
      if (point.color !== 0 || point.usuallyExcluded()) continue;
      point.color = color;
      count++;
      for (const nb of point.neighbors) stack.push(nb);
    }
    return count;
  }

  color(counts) {
    this.resetColor();
    let c = 1;
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      if (p.color !== 0) continue;
      const count = this.colorGroup(i, c);
      if (counts) counts.set(c, count);
      c++;
    }
  }

  ignoreColorsBelow(counts, groupSize) {
    const startColor = this.startId === NO_ID ? -1 : this.points[this.startId].color;
    const endColor = this.endId === NO_ID ? -1 : this.points[this.endId].color;
    for (const p of this.points) {
      if (p.color === startColor || p.color === endColor) continue;
      const cnt = counts.get(p.color);
      if (cnt === undefined) continue;
      if (cnt >= groupSize) continue;
      p.isIgnored = true;
      counts.set(p.color, cnt - 1);
    }
    for (const [k, v] of counts) { if (v === 0) counts.delete(k); }
  }

  findMinimalCrossColorEdges(minimalEdges, searchDistance, largestColor) {
    const pts = this.points;
    for (let i = 0; i < pts.length; i++) {
      const p1 = pts[i];
      if (p1.usuallyExcluded()) continue;
      if (p1.color === largestColor) continue;
      for (const j of this.findPointsWithin(p1.x, p1.y, searchDistance)) {
        const p2 = pts[j];
        if (p2.usuallyExcluded()) continue;
        if (p2.color !== largestColor && p1.color >= p2.color) continue;
        const key = p1.color + ',' + p2.color;
        const distance = p1.monotonicDistanceTo(p2);
        const existing = minimalEdges.get(key);
        if (existing === undefined || existing.distance > distance) {
          if (!this.wouldCrossAnyLong(p1, p2)) {
            minimalEdges.set(key, { distance, from: i, to: j, c1: p1.color, c2: p2.color });
          }
        }
      }
    }
  }

  heroicallyConnect(colorCounts, maxGroupSize) {
    const pts = this.points;
    const minEdges = new Map(); // color -> {distance, from, to}
    const instances = new Map(); // color -> [ids]

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.usuallyExcluded()) continue;
      if ((colorCounts.get(p.color) || 0) > maxGroupSize) continue;

      if (!instances.has(p.color)) instances.set(p.color, []);
      instances.get(p.color).push(i);

      for (let j = 0; j < pts.length; j++) {
        const p2 = pts[j];
        if (p2.color === p.color || p2.usuallyExcluded()) continue;
        const dist = p.monotonicDistanceTo(p2);
        const existing = minEdges.get(p.color);
        if (existing && existing.distance <= dist) continue;
        if (this.wouldCrossAnyLong(p, p2)) continue;
        minEdges.set(p.color, { distance: dist, from: i, to: j });
      }
    }

    const sortedEdges = [...minEdges.values()].sort((a, b) => a.distance - b.distance);

    for (const edge of sortedEdges) {
      const from = pts[edge.from], to = pts[edge.to];
      if (from.color === to.color) continue;
      const fromInst = instances.get(from.color);
      if (!fromInst) continue;
      if (this.wouldCrossAnyLong(from, to)) continue;
      this.connectNeighborsByIds(edge.from, edge.to, edge.distance);

      const fromColor = from.color;
      const toColor = to.color;
      const toInst = instances.get(toColor);
      for (const id of fromInst) {
        pts[id].color = toColor;
        if (toInst) toInst.push(id);
      }
      const fromCount = colorCounts.get(fromColor) || 0;
      colorCounts.set(toColor, (colorCounts.get(toColor) || 0) + fromCount);
      colorCounts.delete(fromColor);
      instances.delete(fromColor);
    }
  }

  connectColors(colorCounts, reach) {
    const minimalEdges = new Map();
    // Find color with largest count
    let largestColor = -1, largestCount = -1;
    for (const [c, cnt] of colorCounts) {
      if (cnt > largestCount) { largestCount = cnt; largestColor = c; }
    }
    this.findMinimalCrossColorEdges(minimalEdges, reach, largestColor);

    const edgeList = [...minimalEdges.values()].sort((a, b) => a.distance - b.distance);

    // Union-find for color merging
    const parent = new Map();
    const getRoot = (c) => {
      if (!parent.has(c)) parent.set(c, c);
      let root = c;
      while (parent.get(root) !== root) root = parent.get(root);
      // Path compression
      let cur = c;
      while (cur !== root) { const next = parent.get(cur); parent.set(cur, root); cur = next; }
      return root;
    };

    let newEdges = 0;
    for (const edge of edgeList) {
      const rootA = getRoot(edge.c1);
      const rootB = getRoot(edge.c2);
      if (rootA === rootB) continue;

      const a = this.points[edge.from], b = this.points[edge.to];
      if (this.wouldCrossAnyLong(a, b)) continue;

      this.connectNeighborsByIds(edge.from, edge.to, a.monotonicDistanceTo(b));
      parent.set(rootB, rootA);
      newEdges++;
    }

    // Recolor
    for (const p of this.points) {
      if (p.usuallyExcluded()) continue;
      const root = getRoot(p.color);
      if (root === p.color) continue;
      const oldCnt = colorCounts.get(p.color) || 0;
      if (oldCnt > 0) colorCounts.set(p.color, oldCnt - 1);
      colorCounts.set(root, (colorCounts.get(root) || 0) + 1);
      if ((colorCounts.get(p.color) || 0) === 0) colorCounts.delete(p.color);
      p.color = root;
    }

    return newEdges;
  }

  connectColorsAll(colorCounts) {
    let searchRadius = this.config.maxReach * 2;
    this.connectColors(colorCounts, searchRadius);
    this.heroicallyConnect(colorCounts, this.config.minimumGroupSize);
    while (colorCounts.size > 1) {
      searchRadius *= 2;
      this.connectColors(colorCounts, searchRadius);
    }
  }

  iterateExpansion(colorCount) {
    // Returns a Promise so the caller must await it
    return new Promise(async (resolve) => {
      for (let iter = 1000; iter > 0; iter--) {
        const change1 = this.expandPath();
        colorCount.clear();
        this.color(colorCount);
        const change2 = this.invadeIslands(colorCount);
        if (this.onProgress) {
          this.onProgress(this.outputSVG(), this.getPathDistance());
          await new Promise(r => setTimeout(r, 0)); // yield so message gets delivered
        }
        if (!change1 && !change2) break;
      }
      for (let iter = 4; iter >= 0; iter--) {
        if (!this.fillHoles()) break;
        if (this.onProgress) {
          this.onProgress(this.outputSVG(), this.getPathDistance());
          await new Promise(r => setTimeout(r, 0));
        }
      }
      resolve();
    });
  }

  async createLine() {
    const colorCounts = new Map();
    this.color(colorCounts);
    this.ignoreColorsBelow(colorCounts, this.config.minimumGroupSize);
    this.connectColorsAll(colorCounts);

    if (!this.connect(this.startId, this.endId)) {
      throw new Error('Could not connect start to end');
    }
    this.hasPath = true;
    if (this.onProgress) this.onProgress(this.outputSVG(), this.getPathDistance());
    await this.iterateExpansion(colorCounts);
  }

  getPathDistance() {
    let length = 0;
    let current = this.startId;
    let next = current === NO_ID ? NO_ID : this.points[current].next;
    while (next !== NO_ID) {
      const a = this.points[current], b = this.points[next];
      const xd = b.x - a.x, yd = b.y - a.y;
      length += Math.sqrt(xd * xd + yd * yd);
      current = next;
      next = b.next;
    }
    return length;
  }

  outputSVG() {
    const cfg = this.config;
    let out = `<svg viewbox='0 0 ${cfg.width} ${cfg.height}' width='${cfg.width}' height='${cfg.height}' xmlns='http://www.w3.org/2000/svg'>\n`;
    out += `<path stroke='black' fill='none' stroke-width='${cfg.strokeWidth}' d='\n`;
    if (cfg.smoothPath) {
      out += this.outputSVGCubic();
    } else {
      out += this.outputSVGLinear();
    }
    out += "' />\n</svg>\n";
    return out;
  }

  outputSVGLinear() {
    const pts = this.points;
    let current = this.startId;
    let out = `M ${pts[current].x} ${pts[current].y} \n`;
    while (pts[current].next !== NO_ID) {
      const next = pts[current].next;
      out += `  L ${pts[current].x} ${pts[current].y}\n`;
      current = next;
    }
    return out;
  }

  outputSVGCubic() {
    const pts = this.points;
    const alpha = 0.5 / 2.0;
    // Angle below which three consecutive points are considered collinear (in radians)
    const straightThreshold = 0.15; // ~8.6 degrees

    function tVal(p1, p2) {
      return Math.pow((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2, alpha);
    }

    function splineControls(p0, p1, p2, p3) {
      let t0 = tVal(p0, p1), t1 = tVal(p1, p2), t2 = tVal(p2, p3);
      const eps = 0.001;
      if (t1 < eps) t1 = 1.0;
      if (t0 < eps) t0 = t1;
      if (t2 < eps) t2 = t1;
      const m1x = ((p1.x - p0.x) / t0 - (p2.x - p0.x) / (t0 + t1) + (p2.x - p1.x) / t1) * t1;
      const m1y = ((p1.y - p0.y) / t0 - (p2.y - p0.y) / (t0 + t1) + (p2.y - p1.y) / t1) * t1;
      const m2x = ((p2.x - p1.x) / t1 - (p3.x - p1.x) / (t1 + t2) + (p3.x - p2.x) / t2) * t1;
      const m2y = ((p2.y - p1.y) / t1 - (p3.y - p1.y) / (t1 + t2) + (p3.y - p2.y) / t2) * t1;
      return [p1.x + m1x / 3, p1.y + m1y / 3, p2.x - m2x / 3, p2.y - m2y / 3];
    }

    function turningAngle(a, b, c) {
      // Angle at b between a→b and b→c
      const dx1 = b.x - a.x, dy1 = b.y - a.y;
      const dx2 = c.x - b.x, dy2 = c.y - b.y;
      const dot = dx1 * dx2 + dy1 * dy2;
      const cross = dx1 * dy2 - dy1 * dx2;
      return Math.abs(Math.atan2(Math.abs(cross), dot));
    }

    let previous = this.startId;
    let current = this.startId;
    let next = current === NO_ID ? NO_ID : pts[current].next;
    let future = next === NO_ID ? NO_ID : pts[next].next;

    if (future === NO_ID) return this.outputSVGLinear();

    let out = `M ${pts[current].x} ${pts[current].y}\n`;
    let inCurve = false;

    do {
      const angle = turningAngle(pts[previous], pts[current], pts[next]);
      const straight = angle < straightThreshold;

      if (straight) {
        if (inCurve) { out += `\n`; inCurve = false; }
        out += `L ${pts[next].x} ${pts[next].y}\n`;
      } else {
        if (!inCurve) { out += `C\n`; inCurve = true; }
        const [cx1, cy1, cx2, cy2] = splineControls(pts[previous], pts[current], pts[next], pts[future !== NO_ID ? future : next]);
        out += `${cx1},${cy1} ${cx2},${cy2} ${pts[next].x},${pts[next].y}\n`;
      }

      previous = current;
      current = next;
      next = future;
      future = future !== NO_ID ? pts[future].next : NO_ID;
    } while (next !== NO_ID);

    return out;
  }
}

// ─── Config factory ──────────────────────────────────────────────────────────

function makeConfig(w, h, opts) {
  // Scale geometry constants proportionally with image size.
  // Reference: maxDim=4500 (resolution=30) → scale=1.
  const maxDim = Math.max(w, h);
  const scale = maxDim / 4500;
  const s = (base) => Math.max(1, Math.round(base * scale));
  return {
    seed: 0,
    width: w,
    height: h,
    pointDensity: s(10),
    pointDensityWhite: s(50),
    whiteCutoff: opts.whiteCutoff,
    invert: !!opts.invert,
    neighborhood: s(15),
    randomPointPercent: 5,
    maxReach: s(100),
    minimumGroupSize: 8,
    edgeQueueSize: 1000,
    maxNeighbors: 6,
    trimHairsShorterThan: s(3),
    minRadianDifference: 20 * Math.PI * 2 / 360,
    strokeWidth: opts.lineWidth,
    smoothPath: true,
  };
}

// ─── Worker message handling ─────────────────────────────────────────────────

let imageBuffer = null; // ArrayBuffer

function setImage(data) {
  imageBuffer = data;
}

async function build(options, seq) {
  const wh = Math.round(options.resolution * 150);
  const maxDim = wh <= 0 ? 50 : wh;

  if (!imageBuffer || imageBuffer.byteLength === 0) {
    return { success: false, error: 'No image data received.' };
  }

  // Decode image to RGBA using createImageBitmap (available in Worker)
  let bitmap;
  try {
    const blob = new Blob([imageBuffer]);
    bitmap = await createImageBitmap(blob);
  } catch (e) {
    return { success: false, error: 'Failed to decode image. Is it a valid jpg or png file?' };
  }

  // Draw to OffscreenCanvas to get RGBA pixels
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const srcW = bitmap.width, srcH = bitmap.height;
  if (!srcW || !srcH) {
    bitmap.close();
    return { success: false, error: 'Failed to decode image dimensions.' };
  }
  const imageData = ctx.getImageData(0, 0, srcW, srcH);
  bitmap.close();

  const img = Image.loadFromRGBA(
    imageData.data, srcW, srcH,
    maxDim, maxDim, 1, options.invert
  );

  img.adjustContrast(options.contrast, options.whiteCutoff, options.invert);

  const config = makeConfig(img.width, img.height, options);
  const points = new Points(config);
  points.fillRandom(img);
  points.makeGrid();
  points.setEndPoints();

  try {
    points.onProgress = (svg, lineLength) => {
      postMessage({ seq, type: 'partial', success: true, result: svg, width: config.width, height: config.height, lineLength });
    };
    await points.createLine();
  } catch (e) {
    return { success: false, error: e.message };
  }

  const svg = points.outputSVG();
  return {
    success: true,
    result: svg,
    width: config.width,
    height: config.height,
    lineLength: points.getPathDistance(),
  };
}

addEventListener('message', async (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'setImage':
      setImage(msg.data);
      break;
    case 'build': {
      const options = JSON.parse(msg.options);
      const result = await build(options, msg.seq);
      result.seq = msg.seq;
      postMessage(result);
      break;
    }
    default:
      console.error('Unknown message type: ' + msg.type);
  }
});
