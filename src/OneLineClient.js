// Worker pool: one worker per logical CPU (capped at 8). Each worker handles
// one build at a time via a per-worker queue.
const POOL_SIZE = Math.min(8, navigator.hardwareConcurrency || 4);

function spawnWorker() {
  const w = new Worker(process.env.PUBLIC_URL + '/oneline.js');
  w.onmessage = handleWorkerMessage;
  w._busy = false;
  w._queue = []; // [{seq, msg, transfer}]
  return w;
}

const workers = Array.from({ length: POOL_SIZE }, spawnWorker);

let seq = 1;
function nextSeq() { return seq++; }

// Queue a job on a specific worker. Drains in FIFO order — only one in-flight at a time.
function enqueue(w, msg, transfer) {
  w._queue.push({ msg, transfer });
  drain(w);
}

function drain(w) {
  if (w._busy || w._queue.length === 0) return;
  const next = w._queue.shift();
  w._busy = true;
  w.postMessage(next.msg, next.transfer || []);
}

// Pick the worker with the shortest queue (least loaded).
function pickLeastBusyWorker() {
  let best = workers[0];
  for (let i = 1; i < workers.length; i++) {
    const score = (workers[i]._busy ? 1 : 0) + workers[i]._queue.length;
    const bestScore = (best._busy ? 1 : 0) + best._queue.length;
    if (score < bestScore) best = workers[i];
  }
  return best;
}

let currentJob = null;
let cancelledSeqs = new Set();

function cancelAll() {
  if (currentJob) {
    for (const s of currentJob.pending) cancelledSeqs.add(s);
    currentJob = null;
  }
  if (partialThrottleTimer) {
    clearTimeout(partialThrottleTimer);
    partialThrottleTimer = null;
    pendingPartialEmit = null;
  }
  // Terminate and recreate workers so mid-flight builds actually stop.
  for (let i = 0; i < workers.length; i++) {
    workers[i].terminate();
    workers[i] = spawnWorker();
  }
}

function setImage(arrayOrBuffer) {
  cancelAll();
  for (const w of workers) {
    const buf = arrayOrBuffer instanceof ArrayBuffer
      ? arrayOrBuffer.slice(0)
      : arrayOrBuffer.buffer.slice(0);
    enqueue(w, { type: 'setImage', seq: nextSeq(), data: buf }, [buf]);
  }
}

function build(options) {
  cancelAll();
  const s = nextSeq();
  const w = pickLeastBusyWorker();
  currentJob = {
    seqToBand: new Map([[s, 0]]),
    svgPaths: [null],
    strokeWidths: [String(options.lineWidth || 1)],
    pending: new Set([s]),
    width: 0,
    height: 0,
    lineLength: 0,
    threads: [{ hex: '#000000' }],
    isSingle: true,
  };
  enqueue(w, { type: 'build', seq: s, options: JSON.stringify(options) });
}

// threads: [{ hex, grayscaleChannel: Uint8Array, width, height, d }]
// Threads with non-null d are pre-rendered — paths injected directly, no dispatch.
function buildMulti(threads, commonOptions) {
  cancelAll();

  const seqToBand = new Map();
  const svgPaths = threads.map(t => (t.d != null) ? t.d : null);
  const strokeWidths = new Array(threads.length).fill(String(commonOptions.lineWidth || 1));
  const pending = new Set();

  // Initial dimensions from any pre-rendered thread (worker results overwrite).
  const preRendered = threads.find(t => t.d);
  let initW = 0, initH = 0;
  if (preRendered) {
    const r = (commonOptions.resolution || 30) * 150;
    const sc = Math.min(r / preRendered.width, r / preRendered.height, 1);
    initW = Math.round(preRendered.width * sc);
    initH = Math.round(preRendered.height * sc);
  }

  currentJob = {
    seqToBand,
    svgPaths,
    strokeWidths,
    pending,
    width: initW,
    height: initH,
    lineLength: 0,
    threads,
    isSingle: false,
  };

  for (let i = 0; i < threads.length; i++) {
    if (threads[i].d != null) continue;
    const { grayscaleChannel, width, height } = threads[i];
    const w = pickLeastBusyWorker();
    const buildSeq = nextSeq();
    seqToBand.set(buildSeq, i);
    pending.add(buildSeq);

    // Send grayscale data INSIDE the build message — no separate setGrayscale step.
    // This guarantees each build is self-contained and queued atomically.
    const gsCopy = grayscaleChannel.slice(0);
    enqueue(w, {
      type: 'buildGrayscale',
      seq: buildSeq,
      data: gsCopy,
      width,
      height,
      options: JSON.stringify(commonOptions),
    }, [gsCopy.buffer]);
  }

  // All threads pre-rendered → emit immediately.
  if (pending.size === 0 && client.onResult) {
    const colorPaths = threads.map((t, i) => ({
      hex: t.hex,
      strokeWidth: strokeWidths[i],
      d: svgPaths[i] || '',
    }));
    const svg = assembleSVG(initW, initH, colorPaths);
    currentJob = null;
    client.onResult({
      success: true,
      result: svg,
      width: initW,
      height: initH,
      lineLength: 0,
      bands: svgPaths.slice(),
    });
  }
}

function extractPath(svg) {
  const swMatch = svg.match(/stroke-width='([^']+)'/);
  const dMatch = svg.match(/\bd='([\s\S]*?)'\s*\/>/);
  return {
    strokeWidth: swMatch ? swMatch[1] : '1',
    d: dMatch ? dMatch[1].trim() : '',
  };
}

function luminanceHex(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
}

function assembleSVG(width, height, colorPaths) {
  const sorted = [...colorPaths].sort((a, b) => luminanceHex(a.hex) - luminanceHex(b.hex));
  let out = `<svg viewBox='0 0 ${width} ${height}' width='${width}' height='${height}' xmlns='http://www.w3.org/2000/svg'>\n`;
  for (const { hex, strokeWidth, d } of sorted) {
    if (!d) continue;
    out += `<path stroke='${hex}' fill='none' stroke-width='${strokeWidth}' d='${d}' />\n`;
  }
  out += `</svg>\n`;
  return out;
}

const PARTIAL_THROTTLE_MS = 500;
let partialThrottleTimer = null;
let pendingPartialEmit = null;

function flushPartial() {
  partialThrottleTimer = null;
  if (pendingPartialEmit) {
    client.onResult(pendingPartialEmit);
    pendingPartialEmit = null;
  }
}

function emitResult(payload, isFinal) {
  if (isFinal) {
    if (partialThrottleTimer) {
      clearTimeout(partialThrottleTimer);
      partialThrottleTimer = null;
      pendingPartialEmit = null;
    }
    client.onResult(payload);
  } else {
    pendingPartialEmit = payload;
    if (!partialThrottleTimer) {
      partialThrottleTimer = setTimeout(flushPartial, PARTIAL_THROTTLE_MS);
    }
  }
}

function handleWorkerMessage(msg) {
  const data = msg.data;
  const s = data.seq;
  const isPartial = data.type === 'partial';
  const w = msg.target;

  // A non-partial reply marks this worker as free to take its next queued job.
  if (!isPartial && w) {
    w._busy = false;
    drain(w);
  }

  if (cancelledSeqs.has(s)) {
    cancelledSeqs.delete(s);
    return;
  }

  if (!client.onResult || !currentJob) return;

  const job = currentJob;

  if (!job.seqToBand.has(s)) {
    // Single-build passthrough.
    if (job.isSingle) {
      if (!isPartial) job.pending.delete(s);
      const allDone = job.pending.size === 0;
      if (allDone) currentJob = null;
      emitResult(data, allDone);
    }
    return;
  }

  const bandIndex = job.seqToBand.get(s);

  if (data.success) {
    const { strokeWidth, d } = extractPath(data.result);
    job.svgPaths[bandIndex] = d;
    job.strokeWidths[bandIndex] = strokeWidth;
    if (data.width) job.width = data.width;
    if (data.height) job.height = data.height;
    if (data.lineLength) job.lineLength += data.lineLength;
  } else {
    job.svgPaths[bandIndex] = '';
  }

  if (!isPartial) job.pending.delete(s);

  const colorPaths = job.threads.map((t, i) => ({
    hex: t.hex,
    strokeWidth: job.strokeWidths[i],
    d: job.svgPaths[i] || '',
  }));
  const allDone = job.pending.size === 0;
  const combinedSVG = assembleSVG(job.width, job.height, colorPaths);

  // Null currentJob BEFORE emitResult: client.onResult may synchronously start
  // a new buildMulti, which sets a fresh currentJob. Nulling after would clobber it.
  if (allDone) currentJob = null;

  emitResult({
    success: true,
    type: allDone ? undefined : 'partial',
    result: combinedSVG,
    width: job.width,
    height: job.height,
    lineLength: job.lineLength,
    bands: allDone ? job.svgPaths.slice() : undefined,
  }, allDone);
}

const client = {
  setImage,
  build,
  buildMulti,
  assembleSVG,
  cancel: cancelAll,
  onResult: undefined,
};

export default client;
