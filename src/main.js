
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

const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, dialog, session, powerMonitor, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');

let appSuspensionBlockerId = null;

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
let currentOpacity = 0.92;
let overlayVisible = true;
let antiTabSwitchShield = true; // Solution C: Strict non-activating overlay

const appDataDir = app.getPath('appData');
const userDataPath = path.join(appDataDir, 'interviewai-pro');
try {
  if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
  app.setPath('userData', userDataPath);
} catch (_) {}

process.on('exit', (code) => {
  console.log('[PROCESS EXIT EVENT] Process exiting with code:', code);
});
app.on('before-quit', () => {
  console.log('[APP BEFORE-QUIT EVENT]');
});
app.on('will-quit', () => {
  console.log('[APP WILL-QUIT EVENT]');
});
app.on('quit', (event, exitCode) => {
  console.log('[APP QUIT EVENT] Exit code:', exitCode);
});
const settingsFile = path.join(userDataPath, 'settings.json');
const sessionsFile = path.join(userDataPath, 'sessions.json');
const referenceFilesStorage = path.join(userDataPath, 'reference-materials.json');
const resumeFilesStorage = path.join(userDataPath, 'resume-materials.json');

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
function loadReferenceFiles() {
  try { return JSON.parse(fs.readFileSync(referenceFilesStorage, 'utf8')); } catch { return []; }
}
function saveReferenceFiles(data) {
  try { fs.writeFileSync(referenceFilesStorage, JSON.stringify(data || [], null, 2)); } catch {}
}
function loadResumeFiles() {
  try { return JSON.parse(fs.readFileSync(resumeFilesStorage, 'utf8')); } catch { return []; }
}
function saveResumeFiles(data) {
  try { fs.writeFileSync(resumeFilesStorage, JSON.stringify(data || [], null, 2)); } catch {}
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
  if (settings.antiTabSwitchShield !== undefined) {
    antiTabSwitchShield = !!settings.antiTabSwitchShield;
  }

  overlayWin = new BrowserWindow({
    width: settings.overlayWidth || 440,
    height: settings.overlayHeight || 560,
    x: settings.overlayX || (width - 460),
    y: settings.overlayY || 20,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    // focusable:false => the overlay never becomes the OS foreground window.
    // Clicking it still works (mouse messages are delivered), but the other
    // app keeps foreground focus, so it never receives a blur event.
    focusable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });

  overlayWin.setContentProtection(true);
  overlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
  currentOpacity = settings.opacity || 0.92;
  overlayWin.setOpacity(currentOpacity);
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));

  overlayWin.webContents.on('render-process-gone', (event, details) => {
    console.error('[OverlayWin Crash Guard] Renderer process gone:', details.reason);
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
    }
  });

  overlayWin.webContents.on('console-message', (event, level, message) => {
    if (level >= 2) console.log('[Overlay Console Error]:', message);
  });

  overlayWin.on('moved', () => {
    const [x, y] = overlayWin.getPosition();
    saveSettings({ ...loadSettings(), overlayX: x, overlayY: y });
  });
  overlayWin.on('resized', () => {
    const [w, h] = overlayWin.getSize();
    saveSettings({ ...loadSettings(), overlayWidth: w, overlayHeight: h });
  });

  // Release the temporary focus we took for typing as soon as focus leaves.
  overlayWin.on('blur', () => {
    setOverlayFocusable(false);
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.setSkipTaskbar(true);
    }
  });

  // The window is created with show:false, so it is already hidden here.
  // Do NOT call hide() on it: a hide -> show cycle leaves a non-activating
  // window without mouse input.
  overlayWin.webContents.on('did-finish-load', () => {
    safeSend(overlayWin, 'auto-send-state', lastAutoSendState);
    safeSend(overlayWin, 'anti-tab-shield-state', antiTabSwitchShield);
    overlayVisible = false;
  });

  overlayWin.on('closed', () => {
    overlayWin = null;
  });
}

// ── FOCUS HYGIENE ──────────────────────────────────────────────────
// The overlay is created non-activating so it can never become the OS
// foreground window. Any app in front (meeting / assessment web page) keeps
// foreground focus, so it never receives a window blur and never reports
// "do not switch windows". Focus is only borrowed while the user is
// actually typing in the overlay's follow-up box, and handed straight back.
let overlayFocusable = false;

function setOverlayFocusable(focusable) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  // Solution C: If Anti-Tab Switch Shield is active, refuse to make window focusable
  if (antiTabSwitchShield && focusable) {
    focusable = false;
  }
  if (overlayFocusable === focusable) return;
  overlayFocusable = focusable;
  try {
    overlayWin.setFocusable(focusable);
    overlayWin.setSkipTaskbar(true);
  } catch (e) {
    console.warn('[Focus] setFocusable failed:', e.message);
  }
}

function toggleAntiTabShield(forcedVal) {
  antiTabSwitchShield = typeof forcedVal === 'boolean' ? forcedVal : !antiTabSwitchShield;
  saveSettings({ ...loadSettings(), antiTabSwitchShield });

  if (antiTabSwitchShield) {
    setOverlayFocusable(false);
  }

  safeSend(overlayWin, 'anti-tab-shield-state', antiTabSwitchShield);
  safeSend(controlWin, 'anti-tab-shield-state', antiTabSwitchShield);
  console.log('[Anti-Tab Switch Shield] State changed to:', antiTabSwitchShield ? 'ON (Safe Mode)' : 'OFF (Normal Mode)');
}

ipcMain.on('toggle-anti-tab-shield', (_, val) => {
  toggleAntiTabShield(val);
});
ipcMain.handle('get-anti-tab-shield-state', () => antiTabSwitchShield);

function showOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.setSkipTaskbar(true);
  overlayWin.setIgnoreMouseEvents(false);
  overlayWin.setOpacity(currentOpacity);
  overlayWin.showInactive();
}

// Hiding the overlay must NOT call hide(): a hide -> show cycle permanently
// strips mouse input from a non-activating window, leaving every button dead.
// Fading it out and letting clicks pass through keeps the window alive.
function hideOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  overlayWin.setOpacity(0);
}

function setOverlayVisible(visible) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayVisible = visible;
  if (visible) showOverlay(); else hideOverlay();
  if (controlWin && !controlWin.isDestroyed()) {
    safeSend(controlWin, 'overlay-visibility', visible);
  }
}

function createControl() {
  controlWin = new BrowserWindow({
    width: 430,
    height: 700,
    minWidth: 380,
    minHeight: 600,
    frame: false,
    transparent: false,
    backgroundColor: '#0d1117',
    skipTaskbar: false,
    resizable: true,
    // Created hidden and shown without activation: launching the app must not
    // pull the foreground away from a browser page (a page that is in an
    // assessment treats losing focus as "the candidate switched away").
    show: false,
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

  controlWin.webContents.on('render-process-gone', (event, details) => {
    console.error('[ControlWin Crash Guard] Renderer process gone:', details.reason);
    if (controlWin && !controlWin.isDestroyed()) {
      controlWin.loadFile(path.join(__dirname, 'control.html'));
    }
  });

  controlWin.webContents.on('console-message', (event, level, message) => {
    if (level >= 2) console.log('[Control Console Error]:', message);
  });

  controlWin.webContents.on('unresponsive', () => {
    console.warn('[ControlWin] Window unresponsive.');
  });

  controlWin.once('ready-to-show', () => {
    if (!controlWin || controlWin.isDestroyed()) return;
    controlWin.show();
    controlWin.focus();
  });

  // Guarantee window is always shown even if ready-to-show event is delayed
  setTimeout(() => {
    if (controlWin && !controlWin.isDestroyed() && !controlWin.isVisible()) {
      controlWin.show();
      controlWin.focus();
    }
  }, 1000);

  controlWin.on('closed', () => {
    console.log('[MAIN] controlWin was closed by user or system');
    controlWin = null;
    if (overlayWin && !overlayWin.isDestroyed()) {
      try { overlayWin.destroy(); } catch (_) {}
    }
    app.exit(0);
  });
}

app.setName('AMD Audio Service');

// Only one instance may run: a second copy would fight over the global
// hotkeys (Alt+A / Alt+H / ...) and leave two overlapping control windows,
// which reads as "the app is not responding".
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (controlWin && !controlWin.isDestroyed()) {
      if (controlWin.isMinimized()) controlWin.restore();
      controlWin.setSkipTaskbar(false);
      controlWin.show();
      controlWin.focus();
    } else {
      createControl();
    }
  });

  app.whenReady().then(() => {
    // Grant permissions at default session level too
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      callback(true);
    });
    session.defaultSession.setPermissionCheckHandler(() => true);

    createOverlay();
    createControl();
    registerShortcuts();

    if (powerMonitor) {
      powerMonitor.on('suspend', () => {
        console.log('[PowerMonitor] System is suspending (entering sleep/standby)...');
        safeSend(controlWin, 'system-power-suspend');
        safeSend(overlayWin, 'system-power-suspend');
      });
      powerMonitor.on('resume', () => {
        console.log('[PowerMonitor] System resumed from sleep/standby');
        safeSend(controlWin, 'system-power-resume');
        safeSend(overlayWin, 'system-power-resume');
      });
      powerMonitor.on('unlock-screen', () => {
        console.log('[PowerMonitor] System screen unlocked');
        safeSend(controlWin, 'system-power-resume');
        safeSend(overlayWin, 'system-power-resume');
      });
    }
  });
}

function toggleOverlayVisibility() {
  if (!overlayWin) return;
  setOverlayVisible(!overlayVisible);
}

function toggleControlPanel() {
  if (controlWin && !controlWin.isDestroyed()) {
    if (controlWin.isVisible()) {
      // Hide Control Panel & REVERT focus to Overlay Window
      controlWin.setSkipTaskbar(true);
      controlWin.hide();

      if (overlayWin && !overlayWin.isDestroyed()) {
        showOverlay();
        overlayVisible = true;
      }
    } else {
      // Bring Control Panel to front
      controlWin.showInactive();
      controlWin.setSkipTaskbar(false);
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
ipcMain.on('force-trigger-answer', () => {
  safeSend(controlWin, 'force-trigger-answer');
  safeSend(overlayWin, 'user-triggered-answer');
});
ipcMain.on('switch-overlay-model', (_, data) => safeSend(controlWin, 'switch-overlay-model', data));
ipcMain.on('sync-active-model', (_, data) => safeSend(overlayWin, 'sync-active-model', data));

// Pending-question confirm flow (Auto-send OFF)
let lastAutoSendState = true;
ipcMain.on('auto-send-state', (_, enabled) => {
  lastAutoSendState = enabled !== false;
  safeSend(overlayWin, 'auto-send-state', lastAutoSendState);
});
ipcMain.on('pending-question', (_, data) => safeSend(overlayWin, 'pending-question', data));
ipcMain.on('pending-question-rejected', (_, data) => safeSend(overlayWin, 'pending-question-rejected', data));
ipcMain.on('pending-question-cleared', () => safeSend(overlayWin, 'pending-question-cleared'));
ipcMain.on('send-pending-question', () => {
  safeSend(controlWin, 'send-pending-question');
  safeSend(overlayWin, 'user-triggered-answer');
});
ipcMain.on('discard-pending-question', () => safeSend(controlWin, 'discard-pending-question'));

// Focus borrowing for the overlay's follow-up box. The overlay is normally
// non-activating; the renderer asks for keyboard focus only when the user
// starts typing, and gives it back as soon as the text is sent or focus moves
// away.
ipcMain.on('overlay-request-focus', () => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (antiTabSwitchShield) {
    safeSend(overlayWin, 'anti-tab-shield-alert', {
      message: '🛡️ Anti-Tab Switch Shield is ON: Focus borrowing blocked to protect test tab. Press Alt+T to turn Shield OFF to type.'
    });
    return;
  }
  setOverlayFocusable(true);
  overlayWin.focus();
});
ipcMain.on('overlay-release-focus', () => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  setOverlayFocusable(false);
});


function registerShortcuts() {
  globalShortcut.unregisterAll();

  // 1. Hide / Show Overlay (Supports Ctrl+Shift+H, Alt+H, and Ctrl+Shift+O)
  ['CommandOrControl+Shift+H', 'Alt+H', 'CommandOrControl+Shift+O'].forEach(key => {
    safeRegisterShortcut(key, toggleOverlayVisibility);
  });

  // 2. Open / Show Control Panel (Supports Ctrl+Shift+C and Ctrl+Shift+M)
  ['CommandOrControl+Shift+C', 'CommandOrControl+Shift+M'].forEach(key => {
    safeRegisterShortcut(key, toggleControlPanel);
  });

  // Focus Overlay Input (Alt+C)
  safeRegisterShortcut('Alt+C', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      setOverlayVisible(true);
      if (antiTabSwitchShield) {
        safeSend(overlayWin, 'anti-tab-shield-alert', {
          message: '🛡️ Anti-Tab Switch Shield is ON: Focus borrowing blocked. Press Alt+T to turn Shield OFF to type.'
        });
        return;
      }
      setOverlayFocusable(true);
      overlayWin.focus();
      safeSend(overlayWin, 'focus-followup-input');
    }
  });

  // Toggle Anti-Tab Switch Shield (Alt+T)
  safeRegisterShortcut('Alt+T', () => {
    toggleAntiTabShield();
  });

  // Capture Multi-Part Screenshot (Alt+P)
  safeRegisterShortcut('Alt+P', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      safeSend(overlayWin, 'trigger-multi-capture');
    }
  });

  // 3. Clear Overlay & Abort Answer (Ctrl+Shift+X and Alt+X)
  ['CommandOrControl+Shift+X', 'Alt+X'].forEach(key => {
    safeRegisterShortcut(key, () => {
      safeSend(overlayWin, 'answer-clear');
      safeSend(controlWin, 'abort-generation');
      safeSend(controlWin, 'discard-pending-question');
    });
  });

  // 4. Force Trigger Answer (Ctrl+Shift+A and Alt+A)
  ['CommandOrControl+Shift+A', 'Alt+A'].forEach(key => {
    safeRegisterShortcut(key, () => {
      safeSend(controlWin, 'force-trigger-answer');
      safeSend(overlayWin, 'user-triggered-answer');
    });
  });

  // 5. Solve Screen / Screenshot (Ctrl+Shift+S and Alt+S)
  ['CommandOrControl+Shift+S', 'Alt+S'].forEach(key => {
    safeRegisterShortcut(key, () => {
      safeSend(controlWin, 'capture-screen-trigger');
      safeSend(overlayWin, 'user-triggered-answer');
    });
  });

  // 6. Opacity & Position Controls
  safeRegisterShortcut('CommandOrControl+Shift+Up', () => {
    if (!overlayWin) return;
    currentOpacity = Math.min(1.0, currentOpacity + 0.08);
    if (overlayVisible) overlayWin.setOpacity(currentOpacity);
    saveSettings({ ...loadSettings(), opacity: currentOpacity });
    if (controlWin) safeSend(controlWin, 'opacity-changed', Math.round(currentOpacity * 100));
  });

  safeRegisterShortcut('CommandOrControl+Shift+Down', () => {
    if (!overlayWin) return;
    currentOpacity = Math.max(0.1, currentOpacity - 0.08);
    if (overlayVisible) overlayWin.setOpacity(currentOpacity);
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
ipcMain.on('force-trigger-answer', () => {
  safeSend(controlWin, 'force-trigger-answer');
  safeSend(overlayWin, 'user-triggered-answer');
});

ipcMain.on('set-opacity', (_, val) => {
  if (!overlayWin) return;
  currentOpacity = val;
  if (overlayVisible) overlayWin.setOpacity(val);
  saveSettings({ ...loadSettings(), opacity: val });
  safeSend(overlayWin, 'opacity-updated', val);
  safeSend(controlWin, 'opacity-updated', val);
});

ipcMain.on('toggle-overlay', () => {
  if (!overlayWin) return;
  setOverlayVisible(!overlayVisible);
});

ipcMain.on('set-control-taskbar', (_, skip) => {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.setSkipTaskbar(skip);
    if (skip) controlWin.hide();
  }
});

ipcMain.on('hide-control-window', () => {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.setSkipTaskbar(true);
    controlWin.hide();
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
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.setSkipTaskbar(true);
    controlWin.hide();
  }
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setSkipTaskbar(true);
    setOverlayVisible(true);
  }
});

ipcMain.on('hide-overlay', () => {
  if (overlayWin) {
    setOverlayVisible(false);
  }
});

ipcMain.on('show-control-window', () => {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.showInactive();
    controlWin.setSkipTaskbar(false);
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
  if (overlayWin && !overlayWin.isDestroyed()) {
    setOverlayVisible(false);
  }
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.showInactive();
    controlWin.setSkipTaskbar(false);
    safeSend(controlWin, 'end-session-remote');
  }
});

// Mic Toggle from Overlay
ipcMain.on('toggle-mic-from-overlay', () => safeSend(controlWin, 'toggle-mic-remote'));
ipcMain.on('mic-state-changed', (_, isListening) => {
  safeSend(overlayWin, 'mic-state-changed', isListening);
  try {
    if (powerSaveBlocker) {
      if (isListening) {
        if (appSuspensionBlockerId === null || !powerSaveBlocker.isStarted(appSuspensionBlockerId)) {
          appSuspensionBlockerId = powerSaveBlocker.start('prevent-app-suspension');
          console.log('[Power] prevent-app-suspension active while listening (Blocker ID:', appSuspensionBlockerId, ')');
        }
      } else {
        if (appSuspensionBlockerId !== null && powerSaveBlocker.isStarted(appSuspensionBlockerId)) {
          powerSaveBlocker.stop(appSuspensionBlockerId);
          console.log('[Power] prevent-app-suspension released');
          appSuspensionBlockerId = null;
        }
      }
    }
  } catch (err) {
    console.warn('[Power] powerSaveBlocker error:', err.message);
  }
});

// Long Question Toggle
ipcMain.on('toggle-long-q-from-overlay', () => safeSend(controlWin, 'toggle-long-q-remote'));
ipcMain.on('long-q-state-changed', (_, state) => safeSend(overlayWin, 'long-q-state-changed', state));

// Follow-up Toggle from Overlay
ipcMain.on('toggle-followup-from-overlay', () => safeSend(controlWin, 'toggle-followup-remote'));
ipcMain.on('followup-state-changed', (_, state) => safeSend(overlayWin, 'followup-state-changed', state));

// Auto-send Toggle from Overlay
ipcMain.on('toggle-autosend-from-overlay', () => safeSend(controlWin, 'toggle-autosend-remote'));

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
  
ipcMain.on('capture-screen', async (_, options = {}) => {
  try {
    const { desktopCapturer } = require('electron');
    // High-speed 1280x720 (720p HD) capture: keeps text & code 100% crisp while cutting visual token encoding overhead by 60%
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
    if (sources.length > 0) {
      const jpegBuffer = sources[0].thumbnail.toJPEG(75);
      const base64 = 'data:image/jpeg;base64,' + jpegBuffer.toString('base64');
      
      // Auto-save screenshot to disk
      const screenshotsDir = path.join(userDataPath, 'screenshots');
      if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
      const filename = `screenshot_${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
      const filePath = path.join(screenshotsDir, filename);
      fs.writeFileSync(filePath, jpegBuffer);
      console.log('[Screen Capture] Saved screenshot to:', filePath, 'Size:', Math.round(base64.length / 1024), 'KB');

      if (options && options.isMultiPart) {
        safeSend(overlayWin, 'screenshot-part-captured', { base64, filePath, filename });
      } else {
        safeSend(controlWin, 'process-screenshot', { base64, filePath, filename });
        safeSend(overlayWin, 'screenshot-saved', { filePath, filename });
      }
    }
  } catch (err) {
    console.error('Failed to capture screen:', err);
    safeSend(overlayWin, 'answer-done');
    safeSend(controlWin, 'status', '❌ Screen capture failed: ' + err.message);
  }
});

ipcMain.on('process-multi-screenshot', (_, parts) => {
  safeSend(controlWin, 'process-multi-screenshot', parts);
});

ipcMain.on('open-screenshots-folder', () => {
  const screenshotsDir = path.join(userDataPath, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
  shell.openPath(screenshotsDir);
});

ipcMain.on('save-session', (_, sessionData) => {
  if (!sessionData) return;
  const sessions = loadSessions();
  const existingIdx = sessionData.id ? sessions.findIndex(s => s.id === sessionData.id) : -1;
  if (existingIdx >= 0) {
    sessions[existingIdx] = { ...sessions[existingIdx], ...sessionData };
  } else {
    sessions.unshift({ ...sessionData, id: sessionData.id || Date.now(), date: sessionData.date || new Date().toISOString() });
    if (sessions.length > 50) sessions.pop();
  }
  saveSessions(sessions);
});

ipcMain.handle('get-sessions', () => loadSessions());
ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_, s) => { saveSettings(s); return true; });
ipcMain.handle('get-reference-files', () => loadReferenceFiles());
ipcMain.on('save-reference-files', (_, data) => saveReferenceFiles(data));
ipcMain.handle('get-resume-files', () => loadResumeFiles());
ipcMain.on('save-resume-files', (_, data) => saveResumeFiles(data));
ipcMain.handle('get-env-config', () => {
  const settings = loadSettings();
  return {
    cerebrasApiKeyAvailable: Boolean(process.env.CEREBRAS_API_KEY),
    cerebrasApiKey: process.env.CEREBRAS_API_KEY || '',
    cerebrasApiBase: process.env.CEREBRAS_API_BASE || 'https://api.cerebras.ai/v1',
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
  let lastTime = null;
  session.qa.forEach((item, i) => {
    if (item.role === 'candidate') {
      content += `Candidate note ${i + 1}: ${item.text || ''}\n\n${'─'.repeat(40)}\n\n`;
    } else {
      let duration = item.durationSec;
      if (!duration && item.time && lastTime) {
        const delta = ((new Date(item.time).getTime() - lastTime) / 1000).toFixed(1);
        if (delta > 0 && delta < 180) duration = delta;
      }
      if (item.time) lastTime = new Date(item.time).getTime();
      const timeStr = duration ? ` [⏱️ ${duration}s response time]` : '';
      content += `Q${i + 1}${timeStr}: ${item.question || ''}\n\nA: ${item.answer || ''}\n\n${'─'.repeat(40)}\n\n`;
    }
  });
  fs.writeFileSync(filePath, content, 'utf8');
  shell.openPath(filePath);
});

ipcMain.on('minimize-control', () => {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.minimize();
  }
});
ipcMain.on('close-app', () => {
  console.log('[MAIN] close-app IPC was invoked');
  if (overlayWin && !overlayWin.isDestroyed()) {
    try { overlayWin.destroy(); } catch (_) {}
  }
  if (controlWin && !controlWin.isDestroyed()) {
    try { controlWin.destroy(); } catch (_) {}
  }
  app.exit(0);
});
ipcMain.on('reasoning-status', (_, data) => safeSend(overlayWin, 'reasoning-status', data));
ipcMain.on('overlay-theme', (_, theme) => safeSend(overlayWin, 'set-theme', theme));
ipcMain.on('overlay-fontsize', (_, size) => safeSend(overlayWin, 'set-fontsize', size));
