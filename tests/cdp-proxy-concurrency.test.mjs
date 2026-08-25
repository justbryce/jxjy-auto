import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function serverFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  assert.ok(payload.length < 126, 'test response must fit in a short WebSocket frame');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function consumeClientFrames(socket, initial = Buffer.alloc(0)) {
  let buffered = initial;
  const consume = chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const masked = Boolean(buffered[1] & 0x80);
      let length = buffered[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      }
      const maskLength = masked ? 4 : 0;
      if (buffered.length < offset + maskLength + length) return;
      const mask = masked ? buffered.subarray(offset, offset + 4) : null;
      offset += maskLength;
      const payload = Buffer.from(buffered.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffered = buffered.subarray(offset + length);

      const message = JSON.parse(payload.toString());
      socket.write(serverFrame({ id: message.id, result: { targetInfos: [] } }));
    }
  };
  socket.on('data', consume);
  if (initial.length) consume(Buffer.alloc(0));
}

async function startFakeChrome({ handshakeDelayMs = 100 } = {}) {
  let upgrades = 0;
  let versionRequests = 0;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      versionRequests++;
      const { port } = server.address();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }));
      return;
    }
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket, head) => {
    upgrades++;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    consumeClientFrames(socket, head);
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    setTimeout(() => socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    ), handshakeDelayMs);
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  return {
    port: server.address().port,
    upgrades: () => upgrades,
    versionRequests: () => versionRequests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function waitForProxy(port, childOutput) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (childOutput.exited) throw new Error(`proxy exited early:\n${childOutput.text}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch { }
    await delay(25);
  }
  throw new Error(`proxy did not start:\n${childOutput.text}`);
}

test('concurrent first requests share one Chrome WebSocket connection', async t => {
  const chrome = await startFakeChrome();
  const proxyPort = await freePort();
  const childOutput = { text: '', exited: false };
  const proxy = spawn(process.execPath, ['tools/cdp-proxy.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(proxyPort), CHROME_PORT: String(chrome.port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proxy.stdout.on('data', chunk => { childOutput.text += chunk; });
  proxy.stderr.on('data', chunk => { childOutput.text += chunk; });
  proxy.once('exit', () => { childOutput.exited = true; });
  t.after(async () => {
    proxy.kill('SIGTERM');
    await chrome.close();
  });

  await waitForProxy(proxyPort, childOutput);
  const results = await Promise.allSettled(Array.from({ length: 20 }, async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/targets`);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }));

  assert.equal(chrome.upgrades(), 1, `expected one browser WebSocket, got ${chrome.upgrades()}\n${childOutput.text}`);
  assert.equal(chrome.versionRequests(), 0, 'daily Chrome connection should not probe /json/version first');
  assert.equal(results.filter(result => result.status === 'rejected').length, 0);
});

test('slow human authorization keeps using the original Chrome WebSocket', async t => {
  const chrome = await startFakeChrome({ handshakeDelayMs: 8250 });
  const proxyPort = await freePort();
  const childOutput = { text: '', exited: false };
  const proxy = spawn(process.execPath, ['tools/cdp-proxy.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(proxyPort), CHROME_PORT: String(chrome.port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proxy.stdout.on('data', chunk => { childOutput.text += chunk; });
  proxy.stderr.on('data', chunk => { childOutput.text += chunk; });
  proxy.once('exit', () => { childOutput.exited = true; });
  t.after(async () => {
    proxy.kill('SIGTERM');
    await chrome.close();
  });

  await waitForProxy(proxyPort, childOutput);
  const requestTargets = async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/targets`);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
  const first = requestTargets().catch(error => error);
  await delay(8050);
  const second = requestTargets().catch(error => error);
  await delay(300);

  assert.equal(chrome.upgrades(), 1, `expected the pending browser WebSocket to be reused, got ${chrome.upgrades()}\n${childOutput.text}`);
  assert.deepEqual(await first, []);
  assert.deepEqual(await second, []);
});
