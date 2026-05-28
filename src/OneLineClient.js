const worker = new Worker(process.env.PUBLIC_URL + '/oneline.js');
worker.onmessage = handleMessage;
let seq = 1;

function setImage(array) {
  // Transfer the ArrayBuffer to avoid copying
  const copy = array.slice(0);
  worker.postMessage({ type: 'setImage', seq: seq++, data: copy }, [copy]);
}

function build(options) {
  worker.postMessage({ type: 'build', seq: seq++, options: JSON.stringify(options) });
}

function handleMessage(msg) {
  if (client.onResult) {
    client.onResult(msg.data);
  }
}

const client = {
  worker,
  setImage,
  build,
  onResult: undefined,
};

export default client;
