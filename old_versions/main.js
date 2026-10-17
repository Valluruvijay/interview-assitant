
// Safe IPC sender that prevents "Object has been destroyed" crashes
function safeSend(win, channel, ...args) {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  } catch (e) {
    // Ignore destroyed window race conditions
  }
}

process.on('uncaughtException', (err) => {
  console.error('[Main Process Exception Guarded]:', err.message);
});

// Polyfill web primitives for pdf-parse v2 in Electron runtime
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; }
  };
}
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); }
  };
}
if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class Path2D {};
}

const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');

// Fix GPU cache access denied errors
const os = require('os');
const cacheDir = require('path').join(os.tmpdir(), 'InterviewAI-cache');
app.commandLine.appendSwitch('disk-cache-dir', cacheDir);
app.commandLine.appendSwitch('disable-gpu-disk-shader-cache');
app.commandLine.appendSwitch('disable-gpu-program-cache');

// Enable speech recognition & media
app.commandLine.appendSwitch('enable-features', 'MediaDevices,WebRTC,SpeechRecognition,WebSpeech');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream', 'false');
app.commandLine.appendSwitch('enable-speech-input');
app.commandLine.appendSwitch('allow-http-background-page');

let overlayWin = null;
let controlWin = null;
let testChatWin = null;
let currentOpacity = 0.92;
let overlayVisible = true;

const userDataPath = app.getPath('userData');
const settingsFile = path.join(userDataPath, 'settings.json');
const sessionsFile = path.join(userDataPath, 'sessions.json');

const SUPPORTED_REFERENCE_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.txt', '.md', '.markdown', '.csv', '.png', '.jpg', '.jpeg'
]);

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; }
}
function saveSettings(data) {
  try { fs.writeFileSync(settingsFile, JSON.stringify(data, null, 2)); } catch {}
}
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(sessionsFile, 'utf8')); } catch { return []; }
}
function saveSessions(data) {
  try { fs.writeFileSync(sessionsFile, JSON.stringify(data, null, 2)); } catch {}
}

function stripXml(value) {
  return String(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractPdfText(buffer) {
  try {
    const pdfPkg = require('pdf-parse');
    const PDFClass = pdfPkg.PDFParse || (typeof pdfPkg === 'function' ? pdfPkg : null);
    if (PDFClass && typeof PDFClass === 'function' && PDFClass.prototype && PDFClass.prototype.load) {
      const parser = new PDFClass({ data: buffer });
      await parser.load();
      const res = await parser.getText();
      const txt = (res && typeof res.text === 'string') ? res.text : (typeof res === 'string' ? res : '');
      if (txt && txt.trim().length > 50) {
        console.log(`[PDF Extractor] Success via PDFParse: ${txt.length} chars extracted`);
        return txt.trim();
      }
    } else if (typeof pdfPkg === 'function') {
      const data = await pdfPkg(buffer);
      if (data && data.text && data.text.trim().length > 50) {
        console.log(`[PDF Extractor] Success via function: ${data.text.length} chars extracted`);
        return data.text.trim();
      }
    }
  } catch (err) {
    console.warn('[PDF Extractor] pdf-parse error:', err);
  }

  return '';
}

function extractDocxBuffer(buffer) {
  return new Promise((resolve) => {
    let yauzl;
    try { yauzl = require('yauzl'); } catch { resolve(''); return; }
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) { resolve(''); return; }
      let done = false;
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (entry.fileName !== 'word/document.xml') {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) { resolve(''); return; }
          const chunks = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            done = true;
            resolve(stripXml(Buffer.concat(chunks).toString('utf8')));
            zipfile.close();
          });
        });
      });
      zipfile.on('end', () => { if (!done) resolve(''); });
      zipfile.on('error', () => resolve(''));
    });
  });
}

function extractDocxText(filePath) {
  return new Promise((resolve) => {
    let yauzl;
    try { yauzl = require('yauzl'); } catch { resolve(''); return; }
    yauzl.open(filePath, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) { resolve(''); return; }
      let done = false;
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (entry.fileName !== 'word/document.xml') {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) { resolve(''); return; }
          const chunks = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            done = true;
            resolve(stripXml(Buffer.concat(chunks).toString('utf8')));
            zipfile.close();
          });
        });
      });
      zipfile.on('end', () => { if (!done) resolve(''); });
      zipfile.on('error', () => resolve(''));
    });
  });
}

async function extractReferenceFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  const base = {
    name: path.basename(filePath),
    path: filePath,
    size: stat.size,
    type: ext.replace('.', '') || 'file',
    text: '',
    warning: ''
  };

  if (!SUPPORTED_REFERENCE_EXTENSIONS.has(ext)) {
    return { ...base, warning: 'Unsupported file type skipped.' };
  }

  if (['.txt', '.md', '.markdown', '.csv'].includes(ext)) {
    return { ...base, text: fs.readFileSync(filePath, 'utf8') };
  }

  if (ext === '.docx') {
    const text = await extractDocxText(filePath);
    return { ...base, text, warning: text ? '' : 'Could not extract DOCX text.' };
  }

  if (ext === '.doc') {
    return { ...base, warning: 'Legacy .doc files are attached by name only. Save as .docx or .txt for text context.' };
  }

  if (ext === '.pdf') {
    const text = await extractPdfText(fs.readFileSync(filePath));
    return { ...base, text, warning: text ? '' : 'PDF text extraction found no selectable text.' };
  }

  return { ...base, warning: 'Image attached. OCR is not available in this local build, so only filename metadata is used.' };
}

function createOverlay() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  const settings = loadSettings();

  overlayWin = new BrowserWindow({
    width: settings.overlayWidth || 440,
    height: settings.overlayHeight || 560,
    x: settings.overlayX || (width - 460),
    y: settings.overlayY || 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    focusable: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });

  overlayWin.setContentProtection(true);
  overlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
  overlayWin.setOpacity(settings.opacity || 0.92);
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));

  overlayWin.on('moved', () => {
    const [x, y] = overlayWin.getPosition();
    saveSettings({ ...loadSettings(), overlayX: x, overlayY: y });
  });
  overlayWin.on('resized', () => {
    const [w, h] = overlayWin.getSize();
    saveSettings({ ...loadSettings(), overlayWidth: w, overlayHeight: h });
  });

  // Hide overlay after it fully loads (webContents ready for IPC) — shows on interview start
  overlayWin.webContents.on('did-finish-load', () => {
    overlayWin.hide();
    overlayVisible = false;
  });

  overlayWin.on('closed', () => {
    overlayWin = null;
  });
}

function createControl() {
  controlWin = new BrowserWindow({
    width: 430,
    height: 700,
    minWidth: 380,
    minHeight: 600,
    frame: false,
    transparent: false,
    skipTaskbar: false,
    resizable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      backgroundThrottling: false
    }
  });

  // Grant ALL permissions automatically — mic, camera, notifications, etc.
  controlWin.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(true);
  });
  controlWin.webContents.session.setPermissionCheckHandler(() => true);

  controlWin.loadFile(path.join(__dirname, 'control.html'));

  controlWin.on('closed', () => {
    controlWin = null;
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
    app.quit();
  });
}

app.setName('AMD Audio Service');

app.whenReady().then(() => {
  // Grant permissions at default session level too
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

  createOverlay();
  createControl();
  registerShortcuts();
});

function toggleOverlayVisibility() {
  if (!overlayWin) return;
  overlayVisible = !overlayVisible;
  if (overlayVisible) {
    overlayWin.show();
  } else {
    overlayWin.hide();
  }
  if (controlWin && !controlWin.isDestroyed()) {
    safeSend(controlWin, 'overlay-visibility', overlayVisible);
  }
}

function toggleControlPanel() {
  if (controlWin && !controlWin.isDestroyed()) {
    const bounds = controlWin.getBounds();
    const isCurrentlyOnScreen = controlWin.isVisible() && bounds.x > -5000;

    if (isCurrentlyOnScreen) {
      // Hide Control Panel & REVERT focus to Overlay Window
      controlWin.savedBounds = bounds;
      controlWin.setBounds({ x: -10000, y: -10000, width: bounds.width, height: bounds.height });
      controlWin.hide();
      controlWin.setSkipTaskbar(true);

      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.show();
        overlayWin.focus();
        overlayVisible = true;
      }
    } else {
      // Bring Control Panel to front
      const targetBounds = (controlWin.savedBounds && controlWin.savedBounds.x > -5000)
        ? controlWin.savedBounds
        : { width: 440, height: 720, x: 80, y: 80 };
      controlWin.setBounds(targetBounds);
      controlWin.setSkipTaskbar(false);
      controlWin.show();
      controlWin.focus();
    }
  } else {
    createControl();
  }
}

function safeRegisterShortcut(shortcut, callback) {
  try {
    const success = globalShortcut.register(shortcut, callback);
    console.log(`[Shortcut] Register ${shortcut}: ${success ? 'SUCCESS' : 'FAILED / CONFLICT'}`);
    return success;
  } catch (err) {
    console.warn(`[Shortcut] Failed to register ${shortcut}:`, err.message);
    return false;
  }
}


ipcMain.on('toggle-overlay-visibility', () => toggleOverlayVisibility());
ipcMain.on('show-control-panel', () => toggleControlPanel());
ipcMain.on('force-trigger-answer', () => safeSend(controlWin, 'force-trigger-answer'));

function registerShortcuts() {
  globalShortcut.unregisterAll();

  // 1. Hide / Show Overlay (Supports Ctrl+Shift+H, Alt+H, and Ctrl+Shift+O)
  ['CommandOrControl+Shift+H', 'Alt+H', 'CommandOrControl+Shift+O'].forEach(key => {
    safeRegisterShortcut(key, toggleOverlayVisibility);
  });

  // 2. Open / Show Control Panel (Supports Ctrl+Shift+C, Alt+C, and Ctrl+Shift+M)
  ['CommandOrControl+Shift+C', 'Alt+C', 'CommandOrControl+Shift+M'].forEach(key => {
    safeRegisterShortcut(key, toggleControlPanel);
  });

  // 3. Clear Overlay & Abort Answer (Ctrl+Shift+X and Alt+X)
  ['CommandOrControl+Shift+X', 'Alt+X'].forEach(key => {
    safeRegisterShortcut(key, () => {
      safeSend(overlayWin, 'answer-clear');
      safeSend(controlWin, 'abort-generation');
    });
  });

  // 4. Force Trigger Answer (Ctrl+Shift+A and Alt+A)
  ['CommandOrControl+Shift+A', 'Alt+A'].forEach(key => {
    safeRegisterShortcut(key, () => {
      safeSend(controlWin, 'force-trigger-answer');
    });
  });

  // 5. Solve Screen / Screenshot (Ctrl+Shift+S and Alt+S)
  ['CommandOrControl+Shift+S', 'Alt+S'].forEach(key => {
    safeRegisterShortcut(key, () => {
      safeSend(controlWin, 'capture-screen-trigger');
    });
  });

  // 6. Opacity & Position Controls
  safeRegisterShortcut('CommandOrControl+Shift+Up', () => {
    if (!overlayWin) return;
    currentOpacity = Math.min(1.0, currentOpacity + 0.08);
    overlayWin.setOpacity(currentOpacity);
    saveSettings({ ...loadSettings(), opacity: currentOpacity });
    if (controlWin) safeSend(controlWin, 'opacity-changed', Math.round(currentOpacity * 100));
  });

  safeRegisterShortcut('CommandOrControl+Shift+Down', () => {
    if (!overlayWin) return;
    currentOpacity = Math.max(0.1, currentOpacity - 0.08);
    overlayWin.setOpacity(currentOpacity);
    saveSettings({ ...loadSettings(), opacity: currentOpacity });
    if (controlWin) safeSend(controlWin, 'opacity-changed', Math.round(currentOpacity * 100));
  });

  safeRegisterShortcut('CommandOrControl+Shift+Left', () => {
    if (!overlayWin) return;
    const [x, y] = overlayWin.getPosition();
    overlayWin.setPosition(Math.max(0, x - 20), y);
  });

  safeRegisterShortcut('CommandOrControl+Shift+Right', () => {
    if (!overlayWin) return;
    const { width } = screen.getPrimaryDisplay().workAreaSize;
    const [x, y] = overlayWin.getPosition();
    overlayWin.setPosition(Math.min(width - 100, x + 20), y);
  });
}


ipcMain.on('enter-stealth-mode', () => {
  // Hide all windows from Task Manager "Apps" tab
  // The overlay already has skipTaskbar: true
  // Control window already gets skipTaskbar: true when interview starts
  
  // Rename the window titles to generic system names
  if (overlayWin) {
    overlayWin.setTitle('');
    overlayWin.setSkipTaskbar(true);
  }
  if (controlWin) {
    controlWin.setTitle('');
    controlWin.setSkipTaskbar(true);
  }
  if (testChatWin) {
    testChatWin.setTitle('');
    testChatWin.setSkipTaskbar(true);
  }
});

ipcMain.on('exit-stealth-mode', () => {
  if (controlWin) {
    controlWin.setTitle('InterviewAI Pro');
    controlWin.setSkipTaskbar(false);
  }
  if (overlayWin) {
    overlayWin.setTitle('');
    overlayWin.setSkipTaskbar(true);
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

ipcMain.on('question-asked', (_, q) => safeSend(overlayWin, 'show-question', q));
ipcMain.on('candidate-spoke', (_, text) => safeSend(overlayWin, 'candidate-spoke', text));
ipcMain.on('candidate-interim', (_, text) => safeSend(overlayWin, 'candidate-interim', text));
ipcMain.on('interviewer-interim', (_, text) => safeSend(overlayWin, 'interviewer-interim', text));
ipcMain.on('answer-chunk', (_, chunk) => safeSend(overlayWin, 'answer-chunk', chunk));
ipcMain.on('answer-done', () => safeSend(overlayWin, 'answer-done'));
ipcMain.on('answer-clear', () => {
  safeSend(overlayWin, 'answer-clear');
  safeSend(controlWin, 'abort-generation');
});
ipcMain.on('abort-generation', () => safeSend(controlWin, 'abort-generation'));
ipcMain.on('force-trigger-answer', () => safeSend(controlWin, 'force-trigger-answer'));

// Test AI Window IPC
ipcMain.on('open-test-chat', () => {
  if (testChatWin) {
    testChatWin.focus();
    return;
  }
  testChatWin = new BrowserWindow({
    width: 480,
    height: 600,
    frame: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  testChatWin.loadFile('src/test-chat.html');
  testChatWin.on('closed', () => { testChatWin = null; });
});
ipcMain.on('test-ai-request', (_, text) => safeSend(controlWin, 'test-ai-request', text));
ipcMain.on('test-ai-chunk', (_, chunk) => safeSend(testChatWin, 'test-ai-chunk', chunk));
ipcMain.on('test-ai-done', () => safeSend(testChatWin, 'test-ai-done'));
ipcMain.on('test-ai-error', (_, err) => safeSend(testChatWin, 'test-ai-error', err));


ipcMain.on('set-opacity', (_, val) => {
  if (!overlayWin) return;
  currentOpacity = val;
  overlayWin.setOpacity(val);
  saveSettings({ ...loadSettings(), opacity: val });
  safeSend(overlayWin, 'opacity-updated', val);
  safeSend(controlWin, 'opacity-updated', val);
});

ipcMain.on('toggle-overlay', () => {
  if (!overlayWin) return;
  overlayVisible = !overlayVisible;
  overlayVisible ? overlayWin.show() : overlayWin.hide();
  if (controlWin) safeSend(controlWin, 'overlay-visibility', overlayVisible);
});

ipcMain.on('set-control-taskbar', (_, skip) => {
  if (controlWin) controlWin.setSkipTaskbar(skip);
});

ipcMain.on('hide-control-window', () => {
  if (controlWin) {
    const bounds = controlWin.getBounds();
    // Only save bounds if not already off-screen
    if (bounds.x > -5000) {
      controlWin.savedBounds = bounds;
    }
    controlWin.setBounds({ x: -10000, y: -10000, width: bounds.width, height: bounds.height });
    controlWin.setSkipTaskbar(true);
  }
});
let preCollapseBounds = null;
ipcMain.on('toggle-collapse-overlay', () => {
  if (!overlayWin) return;
  if (!preCollapseBounds) {
    preCollapseBounds = overlayWin.getBounds();
    overlayWin.setBounds({ width: preCollapseBounds.width, height: 45 });
    safeSend(overlayWin, 'overlay-collapsed', true);
  } else {
    overlayWin.setBounds(preCollapseBounds);
    preCollapseBounds = null;
    safeSend(overlayWin, 'overlay-collapsed', false);
  }
});

ipcMain.on('set-ignore-mouse', (event, ignore) => {
  // Disabled to prevent window freezing
});
ipcMain.on('show-overlay', () => {
  if (overlayWin) {
    overlayWin.show();
    overlayVisible = true;
    safeSend(controlWin, 'overlay-visibility', true);
  }
});

ipcMain.on('hide-overlay', () => {
  if (overlayWin) {
    overlayWin.hide();
    overlayVisible = false;
    safeSend(controlWin, 'overlay-visibility', false);
  }
});

ipcMain.on('show-control-window', () => {
  if (controlWin) {
    const targetBounds = (controlWin.savedBounds && controlWin.savedBounds.x > -5000)
      ? controlWin.savedBounds
      : { width: 440, height: 720, x: 80, y: 80 };
    controlWin.setBounds(targetBounds);
    controlWin.setSkipTaskbar(false);
    controlWin.show();
    controlWin.focus();
  }
});

ipcMain.on('move-overlay-to-display', (_, displayIndex) => {
  const displays = screen.getAllDisplays();
  if (displayIndex < displays.length) {
    const d = displays[displayIndex];
    overlayWin?.setPosition(d.bounds.x + d.bounds.width - 460, d.bounds.y + 20);
  }
});

ipcMain.on('end-session-from-overlay', () => {
  if (overlayWin) {
    overlayWin.hide();
    overlayVisible = false;
  }
  if (controlWin) {
    if (controlWin.savedBounds) {
      controlWin.setBounds(controlWin.savedBounds);
    }
    controlWin.setSkipTaskbar(false);
    controlWin.show();
    controlWin.focus();
    safeSend(controlWin, 'end-session-remote');
  }
});

// Mic Toggle from Overlay
ipcMain.on('toggle-mic-from-overlay', () => safeSend(controlWin, 'toggle-mic-remote'));
ipcMain.on('mic-state-changed', (_, isListening) => safeSend(overlayWin, 'mic-state-changed', isListening));

// Long Question Toggle
ipcMain.on('toggle-long-q-from-overlay', () => safeSend(controlWin, 'toggle-long-q-remote'));
ipcMain.on('long-q-state-changed', (_, state) => safeSend(overlayWin, 'long-q-state-changed', state));

// Follow-up Toggle from Overlay
ipcMain.on('toggle-followup-from-overlay', () => safeSend(controlWin, 'toggle-followup-remote'));
ipcMain.on('followup-state-changed', (_, state) => safeSend(overlayWin, 'followup-state-changed', state));

// Desktop Screenshot Capture
ipcMain.handle('get-desktop-audio-source', async () => {
  try {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    return sources.length > 0 ? sources[0].id : null;
  } catch (err) {
    console.error('Failed to get desktop audio source:', err);
    return null;
  }
});

ipcMain.on('ask-followup', (_, q) => {
    safeSend(controlWin, 'ask-followup', q);
  });
  
ipcMain.on('capture-screen', async () => {
  try {
    const { desktopCapturer } = require('electron');
    // High-speed 1280x720 (720p HD) capture: keeps text & code 100% crisp while cutting visual token encoding overhead by 60%
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
    if (sources.length > 0) {
      const jpegBuffer = sources[0].thumbnail.toJPEG(75);
      const base64 = 'data:image/jpeg;base64,' + jpegBuffer.toString('base64');
      console.log('[Screen Capture] Captured ultra-fast screen, JPEG size:', Math.round(base64.length / 1024), 'KB');
      safeSend(controlWin, 'process-screenshot', base64);
    }
  } catch (err) {
    console.error('Failed to capture screen:', err);
  }
});

ipcMain.on('save-session', (_, sessionData) => {
  const sessions = loadSessions();
  sessions.unshift({ ...sessionData, id: Date.now(), date: new Date().toISOString() });
  if (sessions.length > 50) sessions.pop();
  saveSessions(sessions);
});

ipcMain.handle('get-sessions', () => loadSessions());
ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_, s) => { saveSettings(s); return true; });
ipcMain.handle('get-env-config', () => {
  const settings = loadSettings();
  return {
    zaiApiKeyAvailable: Boolean(process.env.ZAI_API_KEY),
    zAiApiKeyAvailable: Boolean(process.env.Z_AI_API_KEY),
    zaiApiKey: process.env.ZAI_API_KEY || process.env.Z_AI_API_KEY || '',
    zAiApiBase: process.env.ZAI_API_BASE || process.env.Z_AI_API_BASE || 'https://api.z.ai/api/paas/v4',
    savedApiKeys: settings.apiKeys || {}
  };
});
ipcMain.handle('save-api-key', (_, { provider, key }) => {
  const settings = loadSettings();
  if (!settings.apiKeys) settings.apiKeys = {};
  settings.apiKeys[provider] = key;
  saveSettings(settings);
  return true;
});
ipcMain.handle('parse-pdf-path', async (_, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return '';
    const buffer = fs.readFileSync(filePath);
    return await extractPdfText(buffer);
  } catch (err) {
    console.error('parse-pdf-path error:', err);
    return '';
  }
});

ipcMain.handle('parse-pdf-base64', async (_, base64Str) => {
  try {
    const buffer = Buffer.from(base64Str, 'base64');
    return await extractPdfText(buffer);
  } catch (err) {
    console.error('parse-pdf-base64 error:', err);
    return '';
  }
});

ipcMain.handle('parse-docx-path', async (_, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return '';
    const buffer = fs.readFileSync(filePath);
    return await extractDocxBuffer(buffer);
  } catch (err) {
    console.error('parse-docx-path error:', err);
    return '';
  }
});

ipcMain.handle('parse-docx-base64', async (_, base64Str) => {
  try {
    const buffer = Buffer.from(base64Str, 'base64');
    return await extractDocxBuffer(buffer);
  } catch (err) {
    console.error('parse-docx-base64 error:', err);
    return '';
  }
});

ipcMain.handle('extract-reference-files', async (_, filePaths) => {
  const safePaths = Array.isArray(filePaths) ? filePaths.filter(Boolean) : [];
  const results = [];
  for (const filePath of safePaths) {
    try {
      results.push(await extractReferenceFile(filePath));
    } catch (err) {
      results.push({
        name: path.basename(filePath),
        path: filePath,
        size: 0,
        type: path.extname(filePath).replace('.', '') || 'file',
        text: '',
        warning: err.message || 'Extraction failed.'
      });
    }
  }
  return results;
});
ipcMain.handle('get-displays', () =>
  screen.getAllDisplays().map((d, i) => ({
    index: i,
    label: `Display ${i + 1} (${d.bounds.width}×${d.bounds.height})`
  }))
);

ipcMain.on('export-session-pdf', async (_, session) => {
  const { filePath } = await dialog.showSaveDialog({
    defaultPath: `InterviewAI-Session-${new Date().toLocaleDateString('en-GB').replace(/\//g, '-')}.txt`,
    filters: [{ name: 'Text File', extensions: ['txt'] }]
  });
  if (!filePath) return;
  let content = `InterviewAI Pro — Session Report\n`;
  content += `Date: ${new Date(session.date).toLocaleString()}\n`;
  content += `Role: ${session.role || 'General'}\n`;
  content += `Company: ${session.company || 'N/A'}\n\n${'='.repeat(60)}\n\n`;
  session.qa.forEach((item, i) => {
    if (item.role === 'candidate') {
      content += `Candidate note ${i + 1}: ${item.text || ''}\n\n${'─'.repeat(40)}\n\n`;
    } else {
      content += `Q${i + 1}: ${item.question || ''}\n\nA: ${item.answer || ''}\n\n${'─'.repeat(40)}\n\n`;
    }
  });
  fs.writeFileSync(filePath, content, 'utf8');
  shell.openPath(filePath);
});

ipcMain.on('minimize-control', () => controlWin?.minimize());
ipcMain.on('close-app', () => app.quit());
ipcMain.on('overlay-theme', (_, theme) => safeSend(overlayWin, 'set-theme', theme));
ipcMain.on('overlay-fontsize', (_, size) => safeSend(overlayWin, 'set-fontsize', size));
