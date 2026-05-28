// Worker pool: one worker per logical CPU (capped at 8). Each worker handles one
// build at a time. buildMulti dispatches each thread to the least-busy worker.
const POOL_SIZE = Math.min(8, navigator.hardwareConcurrency || 4);

const workers = Array.from({ length: POOL_SIZE }, () => {
  const w = new Worker(process.env.PUBLIC_URL + '/oneline.js');
  w.onmessage = handleWorkerMessage;
  w._pending = new Map(); // seq → resolve fn
  return w;
});

let seq = 1;

// Current job state
let currentJob = null;  // { seqToBand, svgPaths, strokeWidths, pending, width, height, lineLength, threads }
let cancelledSeqs = new Set();

function nextSeq() { return seq++; }

// Round-robin worker assignment
let workerCursor = 0;
function pickWorker() {
  const w = workers[workerCursor % POOL_SIZE];
  workerCursor++;
  return w;
}

function cancelAll() {
  if (currentJob) {
    for (const s of currentJob.pending) cancelledSeqs.add(s);
    currentJob = null;
  }
}

function setImage(array) {
  cancelAll();
  const copy = array.slice(0);
  // Send to all workers so whichever gets the build has the image ready
  for (const w of workers) {
    const imgCopy = copy.slice(0);
    w.postMessage({ type: 'setImage', seq: nextSeq(), data: imgCopy }, [imgCopy.buffer]);
  }
}

function build(options) {
  cancelAll();
  const s = nextSeq();
  const w = pickWorker();
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
  w.postMessage({ type: 'build', seq: s, options: JSON.stringify(options) });
}

// threads: [{ hex, grayscaleChannel: Uint8Array, width, height }]
// commonOptions: shared build options
function buildMulti(threads, commonOptions) {
  cancelAll();

  const seqToBand = new Map();
  const svgPaths = new Array(threads.length).fill(null);
  const strokeWidths = new Array(threads.length).fill(String(commonOptions.lineWidth || 1));
  const pending = new Set();

  currentJob = {
    seqToBand,
    svgPaths,
    strokeWidths,
    pending,
    width: 0,
    height: 0,
    lineLength: 0,
    threads,
    isSingle: false,
  };

  for (let i = 0; i < threads.length; i++) {
    const { grayscaleChannel, width, height } = threads[i];
    const w = pickWorker();

    // Send grayscale channel to this specific worker
    const gsCopy = grayscaleChannel.slice(0);
    const setSeq = nextSeq();
    w.postMessage(
      { type: 'setGrayscale', seq: setSeq, data: gsCopy, width, height },
      [gsCopy.buffer]
    );

    const buildSeq = nextSeq();
    seqToBand.set(buildSeq, i);
    pending.add(buildSeq);
    // Tag which worker owns this seq so we can route the response
    w.postMessage({ type: 'build', seq: buildSeq, options: JSON.stringify(commonOptions) });
  }
}

function extractPath(svg) {
  // stroke-width may be integer or float; d content is multi-line
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

// colorPaths: [{ hex, strokeWidth, d }]
// Render darkest first so lighter threads visually overlap darker ones.
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

function handleWorkerMessage(msg) {
  const data = msg.data;
  const s = data.seq;

  if (cancelledSeqs.has(s)) {
    cancelledSeqs.delete(s);
    return;
  }

  if (!client.onResult) return;
  if (!currentJob) return;

  const job = currentJob;

  if (!job.seqToBand.has(s)) {
    // Single build passthrough (isSingle)
    if (job.isSingle) {
      job.pending.delete(s);
      const allDone = job.pending.size === 0;
      if (allDone) currentJob = null;
      client.onResult(data);
    }
    return;
  }

  const bandIndex = job.seqToBand.get(s);
  const isPartial = data.type === 'partial';

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

  if (!isPartial) {
    job.pending.delete(s);
  }

  const colorPaths = job.threads.map((t, i) => ({
    hex: t.hex,
    strokeWidth: job.strokeWidths[i],
    d: job.svgPaths[i] || '',
  }));
  const allDone = job.pending.size === 0;
  const combinedSVG = assembleSVG(job.width, job.height, colorPaths);

  client.onResult({
    success: true,
    type: allDone ? undefined : 'partial',
    result: combinedSVG,
    width: job.width,
    height: job.height,
    lineLength: job.lineLength,
  });

  if (allDone) currentJob = null;
}

const client = {
  setImage,
  build,
  buildMulti,
  assembleSVG,
  onResult: undefined,
};

export default client;
