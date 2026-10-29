const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printshot', {
  capture: (mode, displayId) => ipcRenderer.send('capture:start', mode, displayId),
  getDisplays: () => ipcRenderer.invoke('displays:list'),
  chooseDisplay: (mode) => ipcRenderer.invoke('capture:choose', mode),
  openWebPage: (url) => ipcRenderer.invoke('webpage:open', url),
  selectDisplay: (mode, displayId) => ipcRenderer.send('capture:display-selected', mode, displayId),
  onChooseDisplay: (cb) => ipcRenderer.on('capture:choose-display', (_e, mode, displays) => cb(mode, displays)),
  onScrollFrames: (cb) => ipcRenderer.on('capture:scroll-finish', (_e, frames) => cb(frames)),
  onMultiDisplayCapture: (cb) => ipcRenderer.on('capture:multi-display', (_e, data) => cb(data)),
  scrollController: {
    onInit: (cb) => ipcRenderer.on('scroll:init', (_e, data) => cb(data)),
    onCount: (cb) => ipcRenderer.on('scroll:count', (_e, count) => cb(count)),
    onError: (cb) => ipcRenderer.on('scroll:error', (_e, msg) => cb(msg)),
    onInfo: (cb) => ipcRenderer.on('scroll:info', (_e, msg) => cb(msg)),
    onState: (cb) => ipcRenderer.on('scroll:state', (_e, data) => cb(data)),
    add: () => ipcRenderer.send('scroll:add-frame'),
    togglePause: () => ipcRenderer.send('scroll:toggle-pause'),
    finish: () => ipcRenderer.send('scroll:finish'),
    cancel: () => ipcRenderer.send('scroll:cancel')
  },
  webCaptureController: {
    onInit: (cb) => ipcRenderer.on('webpage:init', (_e, data) => cb(data)),
    onProgress: (cb) => ipcRenderer.on('webpage:progress', (_e, data) => cb(data)),
    onError: (cb) => ipcRenderer.on('webpage:error', (_e, msg) => cb(msg)),
    start: () => ipcRenderer.send('webpage:start'),
    cancel: () => ipcRenderer.send('webpage:cancel')
  },
  onCapture: (cb) => ipcRenderer.on('capture:new', (_e, dataUrl) => cb(dataUrl)),
  onCaptureError: (cb) => ipcRenderer.on('capture:error', (_e, msg) => cb(msg)),
  saveImage: (dataUrl) => ipcRenderer.invoke('image:save', dataUrl),
  copyImage: (dataUrl) => ipcRenderer.invoke('image:copy', dataUrl),
  copyText: (text) => ipcRenderer.invoke('text:copy', text),
  recognizeText: (dataUrl) => ipcRenderer.invoke('ocr:recognize', dataUrl),
  translateText: (text, source, target) => ipcRenderer.invoke('translation:translate', text, source, target),
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    load: (id) => ipcRenderer.invoke('history:load', id),
    save: (entry) => ipcRenderer.invoke('history:save', entry),
    update: (id, shapes, ocrText) => ipcRenderer.invoke('history:update', id, shapes, ocrText),
    delete: (id) => ipcRenderer.invoke('history:delete', id),
    clear: () => ipcRenderer.invoke('history:clear')
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  overlay: {
    onInit: (cb) => ipcRenderer.on('overlay:init', (_e, data) => cb(data)),
    done: (dataUrl) => ipcRenderer.send('overlay:done', dataUrl),
    selectScrollArea: (area) => ipcRenderer.send('overlay:scroll-area-selected', area),
    cancel: () => ipcRenderer.send('overlay:cancel')
  }
});
