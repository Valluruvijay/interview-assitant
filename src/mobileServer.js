const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const QRCode = require('qrcode');

const DEFAULT_PORT = 47832;
const MAX_PAIRS = 60;

/**
 * Enumerate external IPv4 addresses sorted so real Wi-Fi/Ethernet LAN adapters appear first.
 */
function getLanAddresses() {
  const ifaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, list] of Object.entries(ifaces)) {
    if (!Array.isArray(list)) continue;
    for (const info of list) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue; // link-local APIPA
      let score = 0;
      const lower = name.toLowerCase();
      if (/wi-?fi|wlan|wireless/.test(lower)) score += 40;
      else if (/ethernet|lan/.test(lower)) score += 30;
      if (/vethernet|wsl|virtual|vbox|vmware|hyper-v|docker|tailscale|zerotier|loopback/.test(lower)) score -= 50;
      if (info.address.startsWith('192.168.')) score += 20;
      else if (info.address.startsWith('10.')) score += 15;
      candidates.push({ name, address: info.address, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function constantTimeMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Creates a LAN HTTP + WebSocket companion server that mirrors interview Q&A state
 * to mobile browsers authenticated via a single-session QR token.
 */
function createMobileMirror(options = {}) {
  const htmlPath = options.htmlPath || path.join(__dirname, 'mobile.html');
  const markdownJsPath = options.markdownJsPath || path.join(__dirname, 'markdownRenderer.js');
  const onAction = typeof options.onAction === 'function' ? options.onAction : () => {};
  const onClientsChanged = typeof options.onClientsChanged === 'function' ? options.onClientsChanged : () => {};

  let server = null;
  let wss = null;
  let port = DEFAULT_PORT;
  let enabled = false;
  let token = crypto.randomBytes(12).toString('hex');
  let nextPairId = 1;
  let heartbeatTimer = null;

  const state = {
    pairs: [],
    interviewerInterim: '',
    pendingQuestion: null,
    isReasoning: false,
    autoSend: true,
    followUp: false,
    micListening: false,
    overlayVisible: false,
    model: { provider: '', model: '' }
  };

  function getActivePair() {
    const last = state.pairs[state.pairs.length - 1];
    return (last && !last.done && !last.rejected) ? last : null;
  }

  function trimHistory() {
    if (state.pairs.length > MAX_PAIRS) {
      state.pairs.splice(0, state.pairs.length - MAX_PAIRS);
    }
  }

  function broadcast(payload) {
    if (!wss) return;
    const msg = JSON.stringify(payload);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(msg); } catch (_) {}
      }
    });
  }

  function sendSnapshot(client) {
    if (!client || client.readyState !== WebSocket.OPEN) return;
    try {
      client.send(JSON.stringify({ type: 'snapshot', state }));
    } catch (_) {}
  }

  function notifyClientCount() {
    const count = getConnectedCount();
    onClientsChanged(count);
  }

  function getConnectedCount() {
    if (!wss) return 0;
    let count = 0;
    wss.clients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN) count++;
    });
    return count;
  }

  function buildUrl(address) {
    return `http://${address}:${port}/?token=${token}`;
  }

  async function getInfo(preferredIp = null) {
    const interfaces = getLanAddresses();
    const chosen = (preferredIp && interfaces.find(i => i.address === preferredIp))
      || interfaces[0]
      || { name: 'Localhost', address: '127.0.0.1' };
    const url = buildUrl(chosen.address);
    const allUrls = interfaces.map(i => ({ name: i.name, address: i.address, url: buildUrl(i.address) }));
    const qrDataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 260,
      color: { dark: '#0d1117', light: '#ffffff' }
    });
    return {
      running: enabled && Boolean(server && server.listening),
      port,
      token,
      activeIp: chosen.address,
      activeAdapter: chosen.name,
      url,
      interfaces: allUrls,
      qrDataUrl,
      connectedClients: getConnectedCount()
    };
  }

  function parseRequestAuth(reqUrl) {
    try {
      const parsed = new URL(reqUrl, 'http://localhost');
      return {
        pathname: parsed.pathname,
        token: parsed.searchParams.get('token') || ''
      };
    } catch {
      return { pathname: '/', token: '' };
    }
  }

  function listenOnPort(targetPort) {
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        const { pathname, token: reqToken } = parseRequestAuth(req.url || '/');
        if (!constantTimeMatch(reqToken, token)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('403 Unauthorized — scan a fresh QR code from the desktop app.');
          return;
        }

        if (pathname === '/' || pathname === '/index.html') {
          try {
            const html = fs.readFileSync(htmlPath, 'utf8');
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store'
            });
            res.end(html);
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Mobile UI missing: ' + err.message);
          }
          return;
        }

        if (pathname === '/markdown.js') {
          try {
            const js = fs.readFileSync(markdownJsPath, 'utf8');
            res.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store'
            });
            res.end(js);
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Markdown helper missing: ' + err.message);
          }
          return;
        }

        if (pathname === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, clients: getConnectedCount() }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      });

      s.once('error', (err) => reject(err));
      s.listen(targetPort, '0.0.0.0', () => resolve(s));
    });
  }

  async function start(preferredPort = DEFAULT_PORT) {
    if (server && server.listening) return await getInfo();
    try {
      server = await listenOnPort(preferredPort);
    } catch (err) {
      if (err && err.code === 'EADDRINUSE' && preferredPort !== 0) {
        server = await listenOnPort(0);
      } else {
        throw err;
      }
    }

    const addr = server.address();
    port = (addr && typeof addr === 'object' && addr.port) ? addr.port : DEFAULT_PORT;
    enabled = true;

    wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      const { token: wsToken } = parseRequestAuth(request.url || '/');
      if (!constantTimeMatch(wsToken, token)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });

    wss.on('connection', (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      sendSnapshot(ws);
      notifyClientCount();

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg && msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
          }
          if (msg && typeof msg.action === 'string') {
            onAction(msg);
          }
        } catch (_) {}
      });

      ws.on('close', () => notifyClientCount());
      ws.on('error', () => notifyClientCount());
    });

    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (!wss) return;
      wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          try { ws.terminate(); } catch (_) {}
          return;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch (_) {}
      });
    }, 25000);

    console.log(`[MobileMirror] Listening on 0.0.0.0:${port}`);
    return await getInfo();
  }

  async function stop() {
    enabled = false;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (wss) {
      wss.clients.forEach((ws) => { try { ws.close(1000, 'server stopped'); } catch (_) {} });
      try { wss.close(); } catch (_) {}
      wss = null;
    }
    if (server) {
      await new Promise((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); }
      });
      server = null;
    }
    notifyClientCount();
  }

  async function regenerateToken(preferredIp = null) {
    token = crypto.randomBytes(12).toString('hex');
    if (wss) {
      wss.clients.forEach((ws) => {
        try { ws.close(4403, 'QR token regenerated'); } catch (_) {}
      });
      notifyClientCount();
    }
    return await getInfo(preferredIp);
  }

  // ── State Event Ingestion (called from main.js IPC handlers) ──
  function onQuestionAsked(qData) {
    const prev = getActivePair();
    if (prev) prev.done = true;

    const qText = (typeof qData === 'object' && qData && qData.question) ? qData.question : String(qData || '');
    const intent = (typeof qData === 'object' && qData && qData.intent) ? qData.intent : '';
    const startTime = (typeof qData === 'object' && qData && qData.startTime) ? qData.startTime : Date.now();

    state.interviewerInterim = '';
    state.pendingQuestion = null;
    state.isReasoning = false;

    const pair = {
      id: nextPairId++,
      question: qText,
      intent,
      startTime,
      answer: '',
      done: false,
      rejected: false,
      ttftSec: null,
      durationSec: null
    };
    state.pairs.push(pair);
    trimHistory();
    broadcast({ type: 'question-asked', pair });
  }

  function onInterviewerInterim(text) {
    state.interviewerInterim = String(text || '');
    broadcast({ type: 'interviewer-interim', text: state.interviewerInterim });
  }

  function onAnswerChunk(chunk) {
    const chunkStr = String(chunk || '');
    let pair = getActivePair();
    if (!pair) {
      pair = {
        id: nextPairId++,
        question: '⚡ AI Answer',
        intent: '',
        startTime: Date.now(),
        answer: '',
        done: false,
        rejected: false,
        ttftSec: null,
        durationSec: null
      };
      state.pairs.push(pair);
      trimHistory();
      broadcast({ type: 'question-asked', pair });
    }
    state.isReasoning = false;
    if (pair.ttftSec === null && pair.startTime) {
      pair.ttftSec = Number(((Date.now() - pair.startTime) / 1000).toFixed(1));
    }
    pair.answer += chunkStr;
    broadcast({ type: 'answer-chunk', pairId: pair.id, chunk: chunkStr, ttftSec: pair.ttftSec });
  }

  function onAnswerDone() {
    state.isReasoning = false;
    const pair = getActivePair();
    if (pair) {
      pair.done = true;
      if (pair.startTime) {
        pair.durationSec = Number(((Date.now() - pair.startTime) / 1000).toFixed(1));
      }
      broadcast({ type: 'answer-done', pairId: pair.id, durationSec: pair.durationSec, ttftSec: pair.ttftSec });
    } else {
      broadcast({ type: 'answer-done', pairId: null });
    }
  }

  function onAnswerClear() {
    state.pairs = [];
    state.interviewerInterim = '';
    state.pendingQuestion = null;
    state.isReasoning = false;
    broadcast({ type: 'answer-clear' });
  }

  function onReasoningStatus(data) {
    state.isReasoning = !!(data && data.isReasoning);
    broadcast({ type: 'reasoning-status', isReasoning: state.isReasoning });
  }

  function onPendingQuestion(data) {
    state.pendingQuestion = (data && data.text) ? String(data.text) : '';
    broadcast({ type: 'pending-question', text: state.pendingQuestion });
  }

  function onPendingRejected(data) {
    const text = (data && data.text) ? String(data.text) : '';
    state.pendingQuestion = null;
    state.interviewerInterim = '';
    if (text) {
      const pair = {
        id: nextPairId++,
        question: text,
        intent: '',
        startTime: Date.now(),
        answer: '',
        done: true,
        rejected: true,
        ttftSec: null,
        durationSec: null
      };
      state.pairs.push(pair);
      trimHistory();
      broadcast({ type: 'pending-question-rejected', pair });
    } else {
      broadcast({ type: 'pending-question-cleared' });
    }
  }

  function onPendingCleared() {
    state.pendingQuestion = null;
    broadcast({ type: 'pending-question-cleared' });
  }

  function updateState(patch) {
    if (!patch || typeof patch !== 'object') return;
    Object.assign(state, patch);
    broadcast({ type: 'state', patch });
  }

  return {
    start,
    stop,
    getInfo,
    regenerateToken,
    getConnectedCount,
    onQuestionAsked,
    onInterviewerInterim,
    onAnswerChunk,
    onAnswerDone,
    onAnswerClear,
    onReasoningStatus,
    onPendingQuestion,
    onPendingRejected,
    onPendingCleared,
    updateState
  };
}

module.exports = { createMobileMirror, getLanAddresses };
