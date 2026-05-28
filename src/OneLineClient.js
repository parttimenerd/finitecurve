const worker = new Worker(process.env.PUBLIC_URL + '/oneline.js');
worker.onmessage = handleMessage;
let seq = 1;

let multiJob = null;
let ignoredSeqs = new Set();

function setImage(array) {
  const copy = array.slice(0);
  worker.postMessage({ type: 'setImage', seq: seq++, data: copy }, [copy]);
}

function build(options) {
  abandonMultiJob();
  worker.postMessage({ type: 'build', seq: seq++, options: JSON.stringify(options) });
}

// threads: [{ hex, grayscaleChannel: Uint8Array, width, height }]
// commonOptions: shared build options (resolution, lineWidth, contrast, whiteCutoff, invert, ...)
function buildMulti(threads, commonOptions) {
  abandonMultiJob();

  const seqToBand = new Map();
  const svgPaths = new Array(threads.length).fill(null);
  const strokeWidths = new Array(threads.length).fill(String(commonOptions.lineWidth || 1));

  multiJob = {
    threads,
    seqToBand,
    svgPaths,
    strokeWidths,
    pending: new Set(),
    width: 0,
    height: 0,
    lineLength: 0,
  };

  for (let i = 0; i < threads.length; i++) {
    const { grayscaleChannel, width, height } = threads[i];
    const gsCopy = grayscaleChannel.slice(0);
    const setSeq = seq++;
    worker.postMessage(
      { type: 'setGrayscale', seq: setSeq, data: gsCopy, width, height },
      [gsCopy.buffer]
    );

    const buildSeq = seq++;
    seqToBand.set(buildSeq, i);
    multiJob.pending.add(buildSeq);
    worker.postMessage({ type: 'build', seq: buildSeq, options: JSON.stringify(commonOptions) });
  }
}

function abandonMultiJob() {
  if (multiJob) {
    for (const s of multiJob.pending) ignoredSeqs.add(s);
    multiJob = null;
  }
}

function extractPath(svg) {
  const m = svg.match(/stroke-width='([^']+)'[\s\S]*?d='([\s\S]*?)'\s*\/>/);
  return m ? { strokeWidth: m[1], d: m[2] } : { strokeWidth: '1', d: '' };
}

function assembleSVG(width, height, colorPaths) {
  let out = `<svg viewBox='0 0 ${width} ${height}' width='${width}' height='${height}' xmlns='http://www.w3.org/2000/svg'>\n`;
  for (const { hex, strokeWidth, d } of colorPaths) {
    if (!d) continue;
    out += `<path stroke='${hex}' fill='none' stroke-width='${strokeWidth}' d='${d}' />\n`;
  }
  out += `</svg>\n`;
  return out;
}

function handleMessage(msg) {
  const data = msg.data;

  if (ignoredSeqs.has(data.seq)) {
    ignoredSeqs.delete(data.seq);
    return;
  }

  if (!client.onResult) return;

  if (multiJob && multiJob.seqToBand.has(data.seq)) {
    const bandIndex = multiJob.seqToBand.get(data.seq);
    const isPartial = data.type === 'partial';

    if (data.success) {
      const { strokeWidth, d } = extractPath(data.result);
      multiJob.svgPaths[bandIndex] = d;
      multiJob.strokeWidths[bandIndex] = strokeWidth;
      if (data.width) multiJob.width = data.width;
      if (data.height) multiJob.height = data.height;
      if (data.lineLength) multiJob.lineLength += data.lineLength;
    } else {
      // empty/failed band — treat as empty path, don't propagate error
      multiJob.svgPaths[bandIndex] = '';
    }

    if (!isPartial) {
      multiJob.pending.delete(data.seq);
    }

    const colorPaths = multiJob.threads.map((t, i) => ({
      hex: t.hex,
      strokeWidth: multiJob.strokeWidths[i],
      d: multiJob.svgPaths[i] || '',
    }));
    const allDone = multiJob.pending.size === 0;
    const combinedSVG = assembleSVG(multiJob.width, multiJob.height, colorPaths);

    client.onResult({
      success: true,
      type: allDone ? undefined : 'partial',
      result: combinedSVG,
      width: multiJob.width,
      height: multiJob.height,
      lineLength: multiJob.lineLength,
    });

    if (allDone) multiJob = null;
    return;
  }

  // Single-band passthrough
  client.onResult(data);
}

const client = {
  worker,
  setImage,
  build,
  buildMulti,
  onResult: undefined,
};

export default client;
