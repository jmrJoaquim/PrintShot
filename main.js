const {
  app, BrowserWindow, globalShortcut, desktopCapturer, ipcMain,
  Tray, Menu, nativeImage, dialog, screen, clipboard
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');

let mainWindow = null;
let tray = null;
let overlays = [];
let mainWasVisible = false;
let scrollCapture = null;
let scrollController = null;
let scrollAreaSelection = null;
let webPageWindow = null;
let webPageController = null;
let webPageCaptureRunning = false;
let ocrWorkerPromise = null;
let appUpdater = null;
let updateCheckPromise = null;
let updatePromptOpen = false;

const DEFAULT_SETTINGS = { shortcut: 'PrintScreen', shortcutMode: 'region' };
let settings = { ...DEFAULT_SETTINGS };

/* ---------------- Configurações persistentes ---------------- */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (e) { console.error(e); }
}

/* ---------------- Histórico persistente ---------------- */
const historyDir = () => path.join(app.getPath('userData'), 'history');
const historyIndexFile = () => path.join(historyDir(), 'index.json');

function readHistoryIndex() {
  try { return JSON.parse(fs.readFileSync(historyIndexFile(), 'utf8')); }
  catch { return []; }
}

function writeHistoryIndex(entries) {
  fs.mkdirSync(historyDir(), { recursive: true });
  fs.writeFileSync(historyIndexFile(), JSON.stringify(entries, null, 2));
}

function safeHistoryId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
}

function removeHistoryFiles(entry) {
  for (const name of [entry?.image, entry?.thumbnail]) {
    if (!name || path.basename(name) !== name) continue;
    try { fs.unlinkSync(path.join(historyDir(), name)); } catch {}
  }
}

function imagesNearlyEqual(first, second) {
  if (!first || !second) return false;
  const a = nativeImage.createFromDataURL(first);
  const b = nativeImage.createFromDataURL(second);
  const size = a.getSize();
  if (a.isEmpty() || b.isEmpty() || size.width !== b.getSize().width || size.height !== b.getSize().height) return false;
  const pixelsA = a.toBitmap();
  const pixelsB = b.toBitmap();
  const pixelCount = size.width * size.height;
  const stride = Math.max(1, Math.floor(pixelCount / 5000));
  let matches = 0, samples = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const i = pixel * 4;
    const diff = Math.abs(pixelsA[i] - pixelsB[i]) + Math.abs(pixelsA[i + 1] - pixelsB[i + 1]) + Math.abs(pixelsA[i + 2] - pixelsB[i + 2]);
    if (diff <= 42) matches++;
    samples++;
  }
  return samples > 0 && matches / samples >= 0.99;
}

function sensitiveMatches(text) {
  return [
    { type: 'Senha', regex: /\b(?:senha(?:\s+(?:do|de)\s+(?:usu[aá]rio|acesso|conta))?|password|passcode|pwd|secret|chave\s+secreta)\s*[:=]\s*(.+)$/gi, captureGroup: 1 },
    { type: 'E-mail', regex: /[\w.+-]+@[\w.-]+\.[A-Z]{2,}/gi },
    { type: 'CPF', regex: /\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/g },
    { type: 'CNPJ', regex: /\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[/.\s]?\d{4}[-\s]?\d{2}\b/g },
    { type: 'Telefone', regex: /\b(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9?\d{4})[-.\s]?\d{4}\b/g },
    { type: 'Possível chave/token', regex: /\b(?:sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,})\b/g }
  ];
}

function maskSensitiveText(value, type) {
  if (type === 'Senha') return '••••••';
  if (type === 'E-mail') {
    const [user, domain = ''] = value.split('@');
    return `${user.slice(0, 1)}***@${domain.replace(/^(.{1,2}).*$/, '$1***')}`;
  }
  return `${value.slice(0, 2)}•••${value.slice(-2)}`;
}

function getSensitiveSuggestions(lines, imageSize) {
  const suggestions = [];
  const seenValues = new Set();
  const addSuggestion = (type, masked, boxes, valueKey, defaultSelected = true) => {
    if (!boxes.length || seenValues.has(valueKey)) return;
    const padding = Math.max(4, Math.round((boxes[0].y1 - boxes[0].y0) * 0.12));
    const x0 = Math.max(0, Math.min(...boxes.map((box) => box.x0)) - padding);
    const y0 = Math.max(0, Math.min(...boxes.map((box) => box.y0)) - padding);
    const x1 = Math.min(imageSize.width, Math.max(...boxes.map((box) => box.x1)) + padding);
    const y1 = Math.min(imageSize.height, Math.max(...boxes.map((box) => box.y1)) + padding);
    suggestions.push({ id: randomUUID(), type, masked, defaultSelected, x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) });
    seenValues.add(valueKey);
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const words = (line.words || []).filter((word) => word.text && word.bbox);
    const lineText = line.text || words.map((word) => word.text).join(' ');
    const positions = [];
    let cursor = 0;
    for (const word of words) {
      const start = Math.max(cursor, lineText.indexOf(word.text, cursor));
      const end = start + word.text.length;
      positions.push({ word, start, end });
      cursor = end;
    }

    for (const detector of sensitiveMatches(lineText)) {
      detector.regex.lastIndex = 0;
      let match;
      while ((match = detector.regex.exec(lineText))) {
        const value = (match[detector.captureGroup] || match[0]).trim();
        const valueOffset = detector.captureGroup ? match[0].lastIndexOf(value) : 0;
        const matchStart = match.index + valueOffset;
        const valueKey = detector.type === 'Senha' ? `password:${lineIndex}:${matchStart}`
          : /\d/.test(value) && detector.type !== 'E-mail' ? value.replace(/\D/g, '') : value.toLowerCase();
        if (seenValues.has(valueKey)) continue;
        const affected = positions.filter((item) => item.end > matchStart && item.start < matchStart + value.length);
        const boxes = affected.length ? affected.map((item) => item.word.bbox) : [line.bbox].filter(Boolean);
        addSuggestion(detector.type, maskSensitiveText(value, detector.type), boxes, valueKey);
        if (!match[0].length) detector.regex.lastIndex++;
      }
    }

    const passwordLabel = /^\s*(?:senha(?:\s+(?:do|de)\s+(?:usu[aá]rio|acesso|conta))?|password|passcode|pwd|secret|chave\s+secreta)\s*:?\s*$/i.test(lineText);
    const next = lines[lineIndex + 1];
    if (passwordLabel && line.bbox && next?.bbox) {
      const labelHeight = Math.max(1, line.bbox.y1 - line.bbox.y0);
      const gap = next.bbox.y0 - line.bbox.y1;
      const aligned = next.bbox.x0 < line.bbox.x1 + 360 && next.bbox.x1 > line.bbox.x0 - 40;
      const nextWords = (next.words || []).filter((word) => word.text && word.bbox);
      const looksMasked = /[•●*]{2,}/.test(next.text || '');
      const nextBoxes = nextWords.length ? nextWords.map((word) => word.bbox) : [next.bbox];
      if (gap >= -labelHeight * .25 && gap <= labelHeight * 3 && aligned) {
        addSuggestion('Campo de senha (revisar)', looksMasked ? '••••••' : 'valor logo abaixo do rótulo', nextBoxes, `password-field:${lineIndex}`, false);
      }
    }
  }
  return suggestions;
}

/* ---------------- Janela principal ---------------- */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 680,
    title: 'PrintShot Studio',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#111214',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function showMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ---------------- Bandeja do sistema ---------------- */
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Recortar área da tela', click: () => startCapture('region') },
    { label: 'Capturar tela inteira', click: () => requestDisplayChoice('full') },
    { label: 'Adicionar trecho da página', click: () => takeScrollFrame() },
    { label: 'Finalizar captura com rolagem', click: finishScrollCapture },
    { type: 'separator' },
    { label: 'Abrir PrintShot Studio', click: showMain },
    { label: 'Reiniciar programa', click: () => { app.relaunch(); app.isQuitting = true; app.exit(0); } },
    { label: 'Sair', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  const img = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip(`PrintShot Studio — ${settings.shortcut} para capturar`);
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => (mainWindow.isVisible() ? mainWindow.hide() : showMain()));
}

/* ---------------- Captura ---------------- */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getScreenSources(options) {
  let timer;
  try {
    return await Promise.race([
      desktopCapturer.getSources(options),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Tempo limite ao acessar os monitores.')), 10000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function grabAllDisplays() {
  const displays = screen.getAllDisplays();
  const maxW = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
  const maxH = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));

  const sources = await getScreenSources({
    types: ['screen'],
    thumbnailSize: { width: maxW, height: maxH }
  });

  return displays
    .map((display, i) => {
      const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[i];
      return { display, image: src ? src.thumbnail : null };
    })
    .filter((s) => s.image && !s.image.isEmpty());
}

async function grabDisplay(displayId) {
  const displays = screen.getAllDisplays();
  const displayIndex = displays.findIndex((d) => String(d.id) === String(displayId));
  const display = displays[displayIndex];
  if (!display) throw new Error(`Monitor não encontrado (id: ${displayId})`);
  const width = Math.round(display.size.width * display.scaleFactor);
  const height = Math.round(display.size.height * display.scaleFactor);
  const sources = await getScreenSources({
    types: ['screen'], thumbnailSize: { width, height }
  });
  // Algumas versões/drivers do Windows não preenchem display_id de forma consistente.
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[displayIndex];
  if (!source || source.thumbnail.isEmpty()) throw new Error(`O Windows não forneceu imagem para ${display.label || `o monitor ${displayIndex + 1}`}`);
  return source.thumbnail;
}

function requestDisplayChoice(mode = 'full') {
  if (!mainWindow || scrollCapture) return;
  showMain();
  const displays = screen.getAllDisplays().map((d, i) => ({
    id: String(d.id), label: `Monitor ${i + 1} — ${Math.round(d.size.width * d.scaleFactor)} × ${Math.round(d.size.height * d.scaleFactor)}`,
    primary: d.id === screen.getPrimaryDisplay().id
  }));
  mainWindow.webContents.send('capture:choose-display', mode, displays);
}

async function takeScrollFrame() {
  if (!scrollCapture || scrollCapture.capturing) return null;
  scrollCapture.capturing = true;
  try {
    if (scrollController && !scrollController.isDestroyed()) scrollController.hide();
    await delay(180);
    let image = await grabDisplay(scrollCapture.displayId);
    if (scrollCapture.area) image = image.crop(scrollCapture.area);
    const dataUrl = image.toDataURL();
    const previous = scrollCapture.frames.at(-1);
    if (previous && imagesNearlyEqual(previous, dataUrl)) {
      if (scrollController && !scrollController.isDestroyed()) {
        scrollController.webContents.send('scroll:error', 'O conteúdo não mudou.');
      }
      return false;
    }
    scrollCapture.frames.push(dataUrl);
    if (scrollController && !scrollController.isDestroyed()) {
      scrollController.webContents.send('scroll:count', scrollCapture.frames.length);
    }
    return true;
  } catch (err) {
    console.error('Erro ao capturar trecho da página:', err);
    if (scrollController && !scrollController.isDestroyed()) {
      scrollController.webContents.send('scroll:error', err.message || 'Não foi possível adicionar este trecho.');
    }
    return false;
  } finally {
    if (scrollCapture) scrollCapture.capturing = false;
    if (scrollController && !scrollController.isDestroyed()) scrollController.showInactive();
  }
}

function sendMonitorScroll(displayId) {
  if (process.platform !== 'win32') return Promise.reject(new Error('A rolagem automática do monitor está disponível no Windows. Use “Capturar trecho” para continuar manualmente.'));
  const display = screen.getAllDisplays().find((item) => String(item.id) === String(displayId));
  if (!display) return Promise.reject(new Error('O monitor escolhido não está mais disponível.'));
  const area = scrollCapture?.area || { x: 0, y: 0, width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
  const point = screen.dipToScreenPoint({
    x: Math.round(display.bounds.x + (area.x + area.width / 2) / display.scaleFactor),
    y: Math.round(display.bounds.y + (area.y + area.height * 0.72) / display.scaleFactor)
  });
  const original = screen.dipToScreenPoint(screen.getCursorScreenPoint());
  const ps = [
    "Add-Type -TypeDefinition @'",
    'using System; using System.Runtime.InteropServices;',
    'public static class PrintShotScrollInput {',
    '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
    '[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);',
    '}',
    "'@",
    `[PrintShotScrollInput]::SetCursorPos(${point.x}, ${point.y}) | Out-Null`,
    'Start-Sleep -Milliseconds 100',
    '[PrintShotScrollInput]::mouse_event([uint32]0x0800, [uint32]0, [uint32]0, -840, [UIntPtr]::Zero)',
    'Start-Sleep -Milliseconds 120',
    `[PrintShotScrollInput]::SetCursorPos(${original.x}, ${original.y}) | Out-Null`
  ].join('\n');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, timeout: 8000 }, (error) => {
      if (error) reject(new Error('O Windows não conseguiu rolar o conteúdo. Verifique se há um documento rolável dentro da área selecionada.'));
      else resolve();
    });
  });
}

async function runAutomaticMonitorScroll() {
  while (scrollCapture?.autoRunning) {
    if (scrollCapture.paused) { await delay(200); continue; }
    if (scrollCapture.frames.length >= 40) {
      scrollCapture.paused = true;
      scrollCapture.autoRunning = false;
      if (scrollController && !scrollController.isDestroyed()) {
        scrollController.webContents.send('scroll:state', { paused: true });
        scrollController.webContents.send('scroll:error', 'Limite de 40 trechos atingido. Finalize ou continue manualmente.');
      }
      return;
    }
    try {
      await sendMonitorScroll(scrollCapture.displayId);
      await delay(650);
      if (!scrollCapture?.autoRunning || scrollCapture.paused) continue;
      const changed = await takeScrollFrame();
      if (changed === null) continue;
      if (!changed) {
        if (scrollController && !scrollController.isDestroyed()) scrollController.webContents.send('scroll:error', 'Fim do conteúdo detectado. Abrindo a prévia…');
        await delay(650);
        finishScrollCapture();
        return;
      }
      await delay(350);
    } catch (err) {
      if (scrollCapture) {
        scrollCapture.autoRunning = false;
        scrollCapture.paused = true;
      }
      if (scrollController && !scrollController.isDestroyed()) {
        scrollController.webContents.send('scroll:state', { paused: true });
        scrollController.webContents.send('scroll:error', err.message || 'A rolagem automática falhou. Você ainda pode capturar trechos manualmente.');
      }
      return;
    }
  }
}

async function startScrollCapture(displayId, area = null) {
  if (scrollCapture) return;
  const display = screen.getAllDisplays().find((d) => String(d.id) === String(displayId));
  if (!display) {
    showMain();
    mainWindow.webContents.send('capture:error', 'O monitor selecionado não está mais disponível.');
    return;
  }
  scrollCapture = { displayId, area, frames: [], capturing: false, autoRunning: true, paused: false };
  mainWindow.hide();
  const bounds = display.bounds;
  const controllerWidth = Math.min(680, bounds.width - 24);
  scrollController = new BrowserWindow({
    width: controllerWidth, height: 250,
    x: bounds.x + bounds.width - controllerWidth - 12, y: bounds.y + 24,
    resizable: false, minimizable: true, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false,
    title: 'Captura rolável — PrintShot',
    backgroundColor: '#111214',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  scrollController.setAlwaysOnTop(true, 'floating');
  scrollController.loadFile('scroll-controller.html');
  scrollController.webContents.once('did-finish-load', async () => {
    if (!scrollController || scrollController.isDestroyed()) return;
    scrollController.showInactive();
    scrollController.webContents.send('scroll:init', { shortcut: settings.shortcut });
    await delay(400);
    const firstFrame = await takeScrollFrame();
    if (firstFrame) runAutomaticMonitorScroll();
    else {
      scrollCapture.autoRunning = false;
      scrollController.webContents.send('scroll:state', { paused: true });
      scrollController.webContents.send('scroll:error', 'Não foi possível capturar o monitor. Você pode tentar “Capturar trecho”.');
    }
  });
}

async function beginScrollAreaSelection(displayId) {
  if (!mainWindow || overlays.length || scrollCapture || scrollAreaSelection) return;
  const display = screen.getAllDisplays().find((item) => String(item.id) === String(displayId));
  if (!display) {
    mainWindow.webContents.send('capture:error', 'O monitor selecionado não está mais disponível.');
    showMain();
    return;
  }
  mainWasVisible = mainWindow.isVisible() && !mainWindow.isMinimized();
  scrollAreaSelection = { displayId: String(displayId) };
  mainWindow.hide();
  await delay(300);
  try {
    const image = await grabDisplay(displayId);
    const win = new BrowserWindow({
      x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height,
      frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      skipTaskbar: true, alwaysOnTop: true, enableLargerThanScreen: true, hasShadow: false, show: false,
      backgroundColor: '#000000',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    overlays = [win];
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setBounds(display.bounds);
    win.loadFile('overlay.html');
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      win.webContents.send('overlay:init', { dataUrl: image.toDataURL(), mode: 'scroll-area' });
      win.show();
      win.focus();
    });
  } catch (err) {
    console.error('Erro ao selecionar a área do documento:', err);
    scrollAreaSelection = null;
    closeOverlays();
    showMain();
    mainWindow.webContents.send('capture:error', err.message || 'Não foi possível selecionar a área do documento.');
  }
}

function toggleAutomaticMonitorScroll() {
  if (!scrollCapture) return;
  scrollCapture.paused = !scrollCapture.paused;
  const restartLoop = !scrollCapture.paused && !scrollCapture.autoRunning;
  if (restartLoop) scrollCapture.autoRunning = true;
  if (scrollController && !scrollController.isDestroyed()) {
    scrollController.webContents.send('scroll:state', { paused: scrollCapture.paused });
    if (restartLoop) runAutomaticMonitorScroll();
  }
}

function cancelScrollCapture() {
  if (!scrollCapture) return;
  scrollCapture = null;
  if (scrollController && !scrollController.isDestroyed()) scrollController.destroy();
  scrollController = null;
  showMain();
}

function closeWebPageWindows() {
  webPageCaptureRunning = false;
  const page = webPageWindow;
  const controller = webPageController;
  webPageWindow = null;
  webPageController = null;
  if (controller && !controller.isDestroyed()) controller.destroy();
  if (page && !page.isDestroyed()) page.destroy();
}

function openWebPage(url) {
  let target;
  try {
    target = new URL(String(url || '').trim());
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Use um endereço iniciado com http:// ou https://.');
  } catch (err) {
    return { ok: false, error: err.message || 'Informe um endereço válido.' };
  }
  closeWebPageWindows();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const width = Math.min(1320, area.width - 40);
  const height = Math.min(900, area.height - 70);
  webPageWindow = new BrowserWindow({
    x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2),
    width, height, show: false, title: `PrintShot — ${target.hostname}`,
    webPreferences: {
      partition: 'persist:printshot-page-capture',
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  webPageWindow.once('ready-to-show', () => webPageWindow?.show());
  webPageWindow.webContents.on('did-finish-load', () => {
    if (webPageController && !webPageController.isDestroyed()) {
      webPageController.webContents.send('webpage:init', { title: webPageWindow?.getTitle() || target.hostname });
    }
  });
  webPageWindow.on('closed', () => {
    webPageWindow = null;
    if (webPageController && !webPageController.isDestroyed()) webPageController.destroy();
    webPageController = null;
    webPageCaptureRunning = false;
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) showMain();
  });
  webPageWindow.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (isMainFrame && webPageController && !webPageController.isDestroyed()) {
      webPageController.webContents.send('webpage:error', `Não foi possível carregar a página (${code}): ${description}`);
    }
  });

  const panelWidth = Math.min(680, area.width - 24);
  webPageController = new BrowserWindow({
    x: area.x + area.width - panelWidth - 12, y: area.y + 24,
    width: panelWidth, height: 250, resizable: false, minimizable: true, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, title: 'Capturar página inteira — PrintShot',
    backgroundColor: '#111214',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  webPageController.setAlwaysOnTop(true, 'floating');
  webPageController.loadFile('web-capture-controller.html');
  webPageController.webContents.once('did-finish-load', () => {
    if (!webPageController || webPageController.isDestroyed()) return;
    webPageController.showInactive();
    if (webPageWindow && !webPageWindow.isDestroyed()) {
      webPageController.webContents.send('webpage:init', { title: webPageWindow.getTitle() || target.hostname });
    }
  });
  webPageWindow.loadURL(target.href).catch((err) => {
    if (webPageController && !webPageController.isDestroyed()) webPageController.webContents.send('webpage:error', `Falha ao abrir a URL: ${err.message}`);
  });
  mainWindow?.hide();
  return { ok: true };
}

async function captureWholeWebPage() {
  if (!webPageWindow || webPageWindow.isDestroyed() || webPageCaptureRunning) return;
  webPageCaptureRunning = true;
  const page = webPageWindow;
  const frames = [];
  const sendProgress = (done = false) => {
    if (webPageController && !webPageController.isDestroyed()) webPageController.webContents.send('webpage:progress', { count: frames.length, done });
  };
  const readMetrics = () => page.webContents.executeJavaScript(`(() => {
    const root = document.scrollingElement || document.documentElement;
    return { width: window.innerWidth, viewportHeight: window.innerHeight, height: Math.max(root.scrollHeight, document.body?.scrollHeight || 0), scrollY: root.scrollTop };
  })()`);
  try {
    await page.webContents.executeJavaScript('window.scrollTo(0, 0)');
    await delay(450);
    let targetY = 0;
    for (let i = 0; i < 100; i++) {
      if (!webPageWindow || webPageWindow.isDestroyed()) throw new Error('A janela da página foi fechada.');
      await page.webContents.executeJavaScript(`window.scrollTo(0, ${Math.round(targetY)})`);
      await delay(400);
      let metrics = await readMetrics();
      const shot = await page.webContents.capturePage({ x: 0, y: 0, width: metrics.width, height: metrics.viewportHeight });
      if (shot.isEmpty()) throw new Error('O navegador retornou um trecho vazio.');
      frames.push({ dataUrl: shot.toDataURL(), scrollY: metrics.scrollY, viewportHeight: metrics.viewportHeight });
      sendProgress();
      await delay(350);
      let settled = await readMetrics();
      if (settled.scrollY + settled.viewportHeight >= settled.height - 3) {
        await delay(650);
        settled = await readMetrics();
        if (settled.scrollY + settled.viewportHeight >= settled.height - 3) break;
      }
      const maxScroll = Math.max(0, settled.height - settled.viewportHeight);
      const nextY = Math.min(maxScroll, settled.scrollY + Math.max(1, Math.round(settled.viewportHeight * 0.8)));
      if (nextY <= settled.scrollY + 1) break;
      targetY = nextY;
    }
    if (!frames.length) throw new Error('A página não produziu imagens para a captura.');
    sendProgress(true);
    await delay(300);
    closeWebPageWindows();
    showMain();
    mainWindow.webContents.send('capture:scroll-finish', frames);
  } catch (err) {
    console.error('Erro na captura automática da página:', err);
    webPageCaptureRunning = false;
    if (webPageController && !webPageController.isDestroyed()) webPageController.webContents.send('webpage:error', err.message || 'Não foi possível capturar a página.');
  }
}

function cancelWebPageCapture() {
  closeWebPageWindows();
  showMain();
}

function finishScrollCapture() {
  if (!scrollCapture) return;
  const { frames } = scrollCapture;
  scrollCapture = null;
  if (scrollController && !scrollController.isDestroyed()) scrollController.destroy();
  scrollController = null;
  if (!mainWindow || !frames.length) {
    showMain();
    mainWindow?.webContents.send('capture:error', 'Nenhum trecho foi capturado.');
    return;
  }
  showMain();
  mainWindow.webContents.send('capture:scroll-finish', frames);
}

function deliverCapture(dataUrl) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  showMain();
  const send = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('capture:new', dataUrl);
  };
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', send);
  else send();
}

function deliverAllDisplaysCapture(shots) {
  if (!mainWindow || mainWindow.isDestroyed() || !shots.length) return;
  const displays = screen.getAllDisplays();
  const minX = Math.min(...displays.map((d) => d.bounds.x));
  const minY = Math.min(...displays.map((d) => d.bounds.y));
  const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  const scale = Math.max(...displays.map((d) => d.scaleFactor || 1));
  const payload = {
    width: Math.round((maxX - minX) * scale),
    height: Math.round((maxY - minY) * scale),
    frames: shots.map(({ display, image }) => ({
      dataUrl: image.toDataURL(),
      x: Math.round((display.bounds.x - minX) * scale),
      y: Math.round((display.bounds.y - minY) * scale),
      width: Math.round(display.bounds.width * scale),
      height: Math.round(display.bounds.height * scale)
    }))
  };
  showMain();
  mainWindow.webContents.send('capture:multi-display', payload);
}

function closeOverlays() {
  const list = overlays;
  overlays = [];
  list.forEach((w) => { if (!w.isDestroyed()) w.destroy(); });
}

async function startCapture(mode = 'region', targetDisplayId = null) {
  if (!mainWindow || overlays.length) return;

  mainWasVisible = mainWindow.isVisible() && !mainWindow.isMinimized();
  // Minimizar mantém a janela recuperável na barra de tarefas se a captura falhar.
  if (mode === 'full' || mode === 'all') mainWindow.minimize();
  else mainWindow.hide();
  await delay(350); // espera a janela sair da tela antes de fotografar

  let shots;
  try {
    shots = await grabAllDisplays();
  } catch (err) {
    console.error('Erro na captura:', err);
    showMain();
    mainWindow.webContents.send('capture:error', 'Não foi possível capturar a tela.');
    return;
  }
  if (!shots.length) {
    showMain();
    mainWindow.webContents.send('capture:error', 'Nenhuma tela encontrada para capturar.');
    return;
  }

  if (mode === 'all') {
    deliverAllDisplaysCapture(shots);
    return;
  }
  if (mode === 'full') {
    const displays = screen.getAllDisplays();
    const targetIndex = displays.findIndex((d) => String(d.id) === String(targetDisplayId));
    const target = shots.find((s) => String(s.display.id) === String(targetDisplayId))
      || (targetIndex >= 0 ? shots[targetIndex] : null)
      || shots[0];
    deliverCapture(target.image.toDataURL());
    return;
  }

  overlays = shots.map((shot) => {
    const { bounds } = shot.display;
    const win = new BrowserWindow({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      frame: false, resizable: false, movable: false, minimizable: false,
      maximizable: false, skipTaskbar: true, alwaysOnTop: true,
      enableLargerThanScreen: true, hasShadow: false, show: false,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setBounds(bounds);
    win.loadFile('overlay.html');
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('overlay:init', { dataUrl: shot.image.toDataURL() });
      win.show();
      win.focus();
    });
    return win;
  });
}

/* ---------------- Atalho global ---------------- */
function registerShortcut(shortcut) {
  globalShortcut.unregisterAll();
  try {
    const ok = globalShortcut.register(shortcut, () => {
      if (scrollCapture) {
        if (scrollCapture.frames.length < 40) takeScrollFrame();
        else mainWindow?.webContents.send('capture:error', 'Limite de 40 trechos atingido. Finalize a captura com F10.');
      }
      else if (settings.shortcutMode === 'full') requestDisplayChoice('full');
      else startCapture('region');
    });
    globalShortcut.register('F10', finishScrollCapture);
    globalShortcut.register('Escape', finishScrollCapture);
    if (tray) tray.setToolTip(`PrintShot Studio — ${shortcut} para capturar`);
    return ok;
  } catch (err) {
    console.error('Erro ao registrar atalho:', err);
    return false;
  }
}

function configureAutoUpdates() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater: appUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('O componente de atualização não pôde ser carregado:', err);
    return;
  }

  appUpdater.autoDownload = false;
  appUpdater.autoInstallOnAppQuit = true;
  appUpdater.on('error', (err) => console.warn('Verificação de atualização falhou:', err.message || err));
  appUpdater.on('update-available', async (info) => {
    console.info(`Atualização ${info.version} encontrada.`);
    if (updatePromptOpen) return;
    updatePromptOpen = true;
    try {
      const result = await dialog.showMessageBox({
        type: 'info',
        title: 'Atualização do PrintShot disponível',
        message: `A versão ${info.version} está disponível.`,
        detail: 'Deseja baixar e instalar esta atualização agora? Se escolher “Agora não”, você continuará usando esta versão e será avisado novamente na próxima vez que abrir o PrintShot.',
        buttons: ['Baixar e instalar', 'Agora não'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      });
      if (result.response === 0) {
        await appUpdater.downloadUpdate();
      }
    } catch (err) {
      console.error('Não foi possível iniciar o download da atualização:', err.message || err);
    } finally {
      updatePromptOpen = false;
    }
  });
  appUpdater.on('update-downloaded', async (info) => {
    try {
      const result = await dialog.showMessageBox({
        type: 'info',
        title: 'Atualização do PrintShot pronta',
        message: `A versão ${info.version} foi baixada.`,
        detail: 'Reinicie o PrintShot agora para concluir a instalação. Se escolher mais tarde, ela será instalada quando o aplicativo for fechado.',
        buttons: ['Reiniciar agora', 'Mais tarde'],
        defaultId: 0,
        cancelId: 1
      });
      if (result.response === 0) appUpdater.quitAndInstall();
    } catch (err) {
      console.error('Não foi possível exibir a confirmação da atualização:', err);
    }
  });

  const checkForUpdates = () => checkForAppUpdates().catch((err) => {
    console.warn('Não foi possível consultar atualizações do PrintShot:', err.message || err);
  });
  const startupCheck = setTimeout(checkForUpdates, 10000);
  startupCheck.unref?.();
}

function checkForAppUpdates() {
  if (!appUpdater) return Promise.reject(new Error('O serviço de atualização não está disponível.'));
  if (updateCheckPromise) return updateCheckPromise;
  updateCheckPromise = appUpdater.checkForUpdates().finally(() => { updateCheckPromise = null; });
  return updateCheckPromise;
}

/* ---------------- Comunicação com as telas ---------------- */
ipcMain.on('capture:start', async (_e, mode, displayId) => {
  if (mode === 'scroll') {
    beginScrollAreaSelection(displayId);
    return;
  }
  if (mode === 'all') {
    startCapture('all');
    return;
  }
  startCapture('region');
});

ipcMain.handle('displays:list', () => screen.getAllDisplays().map((d, i) => ({
  id: String(d.id), label: `Monitor ${i + 1} — ${Math.round(d.size.width * d.scaleFactor)} × ${Math.round(d.size.height * d.scaleFactor)}`,
  primary: d.id === screen.getPrimaryDisplay().id
})));
ipcMain.handle('capture:choose', (_e, mode) => requestDisplayChoice(mode === 'scroll' ? 'scroll' : 'full'));
ipcMain.handle('webpage:open', (_e, url) => openWebPage(url));
ipcMain.on('webpage:start', captureWholeWebPage);
ipcMain.on('webpage:cancel', cancelWebPageCapture);
ipcMain.on('capture:display-selected', (_e, mode, displayId) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (displayId !== 'all' && !screen.getAllDisplays().some((d) => String(d.id) === String(displayId))) {
    showMain();
    mainWindow.webContents.send('capture:error', 'O monitor selecionado não está mais disponível. Selecione-o novamente.');
    return;
  }
  if (mode === 'scroll') {
    beginScrollAreaSelection(displayId);
  }
  else if (displayId === 'all') startCapture('all');
  else startCapture('full', displayId);
});

ipcMain.on('scroll:add-frame', () => {
  if (!scrollCapture) return;
  if (scrollCapture.autoRunning && !scrollCapture.paused) {
    scrollCapture.paused = true;
    scrollController?.webContents.send('scroll:state', { paused: true });
  }
  takeScrollFrame();
});
ipcMain.on('scroll:toggle-pause', toggleAutomaticMonitorScroll);
ipcMain.on('scroll:finish', finishScrollCapture);
ipcMain.on('scroll:cancel', cancelScrollCapture);

ipcMain.on('overlay:scroll-area-selected', (_event, rawArea) => {
  if (!scrollAreaSelection) return;
  const pending = scrollAreaSelection;
  scrollAreaSelection = null;
  closeOverlays();
  const display = screen.getAllDisplays().find((item) => String(item.id) === pending.displayId);
  if (!display || !rawArea || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rawArea[key]))) {
    showMain();
    mainWindow?.webContents.send('capture:error', 'A área selecionada não é válida. Tente novamente.');
    return;
  }
  const maxWidth = Math.round(display.size.width * display.scaleFactor);
  const maxHeight = Math.round(display.size.height * display.scaleFactor);
  const x = Math.max(0, Math.min(maxWidth - 1, Math.round(rawArea.x)));
  const y = Math.max(0, Math.min(maxHeight - 1, Math.round(rawArea.y)));
  const width = Math.max(1, Math.min(maxWidth - x, Math.round(rawArea.width)));
  const height = Math.max(1, Math.min(maxHeight - y, Math.round(rawArea.height)));
  if (width < 30 || height < 30) {
    showMain();
    mainWindow?.webContents.send('capture:error', 'Selecione uma área maior que 30 × 30 pixels.');
    return;
  }
  startScrollCapture(pending.displayId, { x, y, width, height });
});

ipcMain.on('overlay:done', (_e, dataUrl) => {
  closeOverlays();
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) deliverCapture(dataUrl);
});

ipcMain.on('overlay:cancel', () => {
  closeOverlays();
  if (scrollAreaSelection) {
    scrollAreaSelection = null;
    if (mainWasVisible) showMain();
    return;
  }
  if (mainWasVisible) showMain();
});

ipcMain.handle('image:save', async (_e, dataUrl) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Salvar print',
    defaultPath: path.join(app.getPath('pictures'), `PrintShot_${stamp}.png`),
    filters: [
      { name: 'Imagem PNG', extensions: ['png'] },
      { name: 'Imagem JPG (arquivo menor)', extensions: ['jpg', 'jpeg'] }
    ]
  });
  if (canceled || !filePath) return null;

  const img = nativeImage.createFromDataURL(dataUrl);
  const isJpg = /\.jpe?g$/i.test(filePath);
  fs.writeFileSync(filePath, isJpg ? img.toJPEG(100) : img.toPNG());
  return filePath;
});

ipcMain.handle('image:copy', (_e, dataUrl) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return false;
  clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
  return true;
});

ipcMain.handle('text:copy', (_e, text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});

ipcMain.handle('history:list', () => {
  return readHistoryIndex().map((entry) => {
    try {
      const thumbnail = fs.readFileSync(path.join(historyDir(), entry.thumbnail));
      return { ...entry, thumb: `data:image/jpeg;base64,${thumbnail.toString('base64')}` };
    } catch { return null; }
  }).filter(Boolean);
});

ipcMain.handle('history:load', (_e, id) => {
  const safeId = safeHistoryId(id);
  const entry = readHistoryIndex().find((item) => item.id === safeId);
  if (!entry) return null;
  try {
    const image = fs.readFileSync(path.join(historyDir(), entry.image));
    return `data:image/png;base64,${image.toString('base64')}`;
  } catch { return null; }
});

ipcMain.handle('history:save', (_e, data) => {
  if (!data || typeof data.src !== 'string' || !data.src.startsWith('data:image/')) return false;
  const id = safeHistoryId(data.id) || randomUUID();
  fs.mkdirSync(historyDir(), { recursive: true });
  const imageName = `${id}.png`;
  const thumbName = `${id}-thumb.jpg`;
  const image = nativeImage.createFromDataURL(data.src);
  if (image.isEmpty()) return false;
  fs.writeFileSync(path.join(historyDir(), imageName), image.toPNG());
  const thumb = typeof data.thumb === 'string' ? nativeImage.createFromDataURL(data.thumb) : image;
  fs.writeFileSync(path.join(historyDir(), thumbName), (thumb.isEmpty() ? image : thumb).toJPEG(78));
  const entries = readHistoryIndex().filter((entry) => entry.id !== id);
  entries.unshift({
    id, image: imageName, thumbnail: thumbName,
    name: String(data.name || `PrintShot ${new Date(data.time || Date.now()).toLocaleString('pt-BR')}`),
    shapes: typeof data.shapes === 'string' ? data.shapes : '[]',
    ocrText: '',
    time: data.time || new Date().toISOString(),
    w: Number(data.w) || image.getSize().width, h: Number(data.h) || image.getSize().height
  });
  while (entries.length > 50) removeHistoryFiles(entries.pop());
  writeHistoryIndex(entries);
  return true;
});

ipcMain.handle('history:update', (_e, id, shapes, ocrText) => {
  const safeId = safeHistoryId(id);
  const entries = readHistoryIndex();
  const entry = entries.find((item) => item.id === safeId);
  if (!entry) return false;
  entry.shapes = typeof shapes === 'string' ? shapes : '[]';
  if (typeof ocrText === 'string') entry.ocrText = ocrText;
  writeHistoryIndex(entries);
  return true;
});

ipcMain.handle('history:delete', (_e, id) => {
  const safeId = safeHistoryId(id);
  const entries = readHistoryIndex();
  const entry = entries.find((item) => item.id === safeId);
  if (!entry) return false;
  removeHistoryFiles(entry);
  writeHistoryIndex(entries.filter((item) => item.id !== safeId));
  return true;
});

ipcMain.handle('history:clear', () => {
  for (const entry of readHistoryIndex()) removeHistoryFiles(entry);
  writeHistoryIndex([]);
  return true;
});

ipcMain.handle('ocr:recognize', async (_e, dataUrl) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) throw new Error('A imagem para OCR não é válida.');
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) throw new Error('Não foi possível abrir a imagem para OCR.');
  if (!ocrWorkerPromise) {
    const { createWorker } = require('tesseract.js');
    const cachePath = path.join(app.getPath('userData'), 'ocr-cache');
    fs.mkdirSync(cachePath, { recursive: true });
    ocrWorkerPromise = createWorker(['por', 'eng'], 1, {
      cachePath
    }).catch((err) => { ocrWorkerPromise = null; throw err; });
  }
  const worker = await ocrWorkerPromise;
  const { data: result } = await worker.recognize(image.toPNG(), {}, { blocks: true });
  const lines = (result.blocks || []).flatMap((block) => (block.paragraphs || []).flatMap((paragraph) => paragraph.lines || []));
  return { text: result.text || '', suggestions: getSensitiveSuggestions(lines, image.getSize()) };
});

ipcMain.handle('translation:translate', async (_e, text, source, target) => {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Não há texto para traduzir.');
  if (text.length > 20000) throw new Error('O texto ultrapassa o limite de 20.000 caracteres por tradução.');
  const languageCodes = new Set(['pt', 'en', 'es', 'fr', 'de', 'it', 'ja', 'zh-CN', 'ru', 'ko', 'nl']);
  if (!languageCodes.has(source) || !languageCodes.has(target) || source === target) throw new Error('Selecione idiomas de origem e destino diferentes.');

  // MyMemory accepts up to 500 UTF-8 bytes per request. Preserve paragraph breaks
  // while splitting oversized paragraphs into sentence-sized pieces.
  const encoder = new TextEncoder();
  const splitToLimit = (value) => {
    const pieces = [];
    let current = '';
    const words = value.match(/\S+\s*/gu) || [];
    for (const word of words) {
      if (encoder.encode(current + word).length > 450 && current) {
        pieces.push(current.trim());
        current = '';
      }
      if (encoder.encode(word).length > 450) throw new Error('Há uma palavra muito longa para traduzir.');
      current += word;
    }
    if (current.trim()) pieces.push(current.trim());
    return pieces;
  };
  const paragraphs = text.split(/(\n\s*\n)/);
  const translated = [];
  for (const paragraph of paragraphs) {
    if (/^\n\s*\n$/.test(paragraph)) { translated.push(paragraph); continue; }
    const chunks = splitToLimit(paragraph);
    const results = [];
    for (const chunk of chunks) {
      const url = new URL('https://api.mymemory.translated.net/get');
      url.searchParams.set('q', chunk);
      url.searchParams.set('langpair', `${source}|${target}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`Serviço de tradução indisponível (HTTP ${response.status}).`);
      const payload = await response.json();
      if (payload.responseStatus !== 200 || !payload.responseData?.translatedText) {
        throw new Error(payload.responseDetails || 'O serviço não conseguiu traduzir este trecho.');
      }
      results.push(payload.responseData.translatedText);
    }
    translated.push(results.join(' '));
  }
  return { text: translated.join('') };
});

ipcMain.handle('settings:get', () => ({ ...settings, version: app.getVersion() }));

ipcMain.handle('updates:check', async () => {
  if (!app.isPackaged) return { ok: false, error: 'A verificação só funciona na versão instalada.' };
  if (!appUpdater) return { ok: false, error: 'O serviço de atualização não está disponível.' };
  try {
    const result = await checkForAppUpdates();
    return {
      ok: true,
      available: Boolean(result?.isUpdateAvailable),
      version: result?.updateInfo?.version || app.getVersion(),
      currentVersion: app.getVersion()
    };
  } catch (err) {
    return { ok: false, error: err.message || 'Não foi possível verificar atualizações.' };
  }
});

ipcMain.handle('settings:set', (_e, next) => {
  const previous = { ...settings };
  settings = {
    shortcut: typeof next?.shortcut === 'string' ? next.shortcut : settings.shortcut,
    shortcutMode: next?.shortcutMode === 'full' ? 'full' : 'region'
  };
  if (!registerShortcut(settings.shortcut)) {
    settings = previous;
    registerShortcut(settings.shortcut);
    return { ok: false, settings };
  }
  saveSettings();
  return { ok: true, settings };
});

/* ---------------- Ciclo de vida ---------------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);

  app.whenReady().then(() => {
    loadSettings();
    createWindow();
    createTray();
    registerShortcut(settings.shortcut);
    configureAutoUpdates();
  });

  app.on('before-quit', () => { app.isQuitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (ocrWorkerPromise) ocrWorkerPromise.then((worker) => worker.terminate()).catch(() => {});
  });
}
