const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('arcinityAPI', {
  loadSettings:    () => ipcRenderer.invoke('settings:load'),
  pickVideoFolder: () => ipcRenderer.invoke('settings:pickFolder'),
  startServer:     (payload) => ipcRenderer.invoke('server:start', payload),
  stopServer:      () => ipcRenderer.invoke('server:stop'),
  setServerRecommendationMode: (payload) => ipcRenderer.invoke('server:setRecommendationMode', payload),
  setServerStreamSettings: (payload) => ipcRenderer.invoke('server:setStreamSettings', payload),
  getServerStatus: () => ipcRenderer.invoke('server:status'),
  openBrowser:     (url) => ipcRenderer.invoke('server:openBrowser', url),
  scanThumbs:      (args) => ipcRenderer.invoke('thumbs:scan', args),
  generateThumbs:  (args) => ipcRenderer.invoke('thumbs:generate', args),
  cancelThumbs:    () => ipcRenderer.invoke('thumbs:cancel'),

  // ── Deep Learning Indexer ──────────────────────────────────────────────────
  deepLearnGetDataPath: ()     => ipcRenderer.invoke('deeplearn:getDataPath'),
  deepLearnCheckDeps:   ()     => ipcRenderer.invoke('deeplearn:checkDeps'),
  deepLearnScan:        (args) => ipcRenderer.invoke('deeplearn:scan', args),
  deepLearnRun:         (args) => ipcRenderer.invoke('deeplearn:run', args),
  deepLearnCancel:      ()     => ipcRenderer.invoke('deeplearn:cancel'),
  deepLearnInstallDeps: ()     => ipcRenderer.invoke('deeplearn:installDeps'),

  windowMinimize:       ()     => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: ()     => ipcRenderer.invoke('window:toggleMaximize'),
  windowClose:          ()     => ipcRenderer.invoke('window:close'),
  windowIsMaximized:    ()     => ipcRenderer.invoke('window:isMaximized'),

  onServerLog: (handler) => {
    ipcRenderer.on('server:log', (_event, line) => handler(line));
  },
  onServerState: (handler) => {
    ipcRenderer.on('server:state', (_event, payload) => handler(payload));
  },
  onThumbsProgress: (handler) => {
    ipcRenderer.on('thumbs:progress', (_event, data) => handler(data));
  },
  onDeepLearnProgress: (handler) => {
    ipcRenderer.on('deeplearn:progress', (_event, data) => handler(data));
  },
  onDeepLearnInstallLog: (handler) => {
    ipcRenderer.on('deeplearn:install-log', (_event, data) => handler(data));
  },
});

