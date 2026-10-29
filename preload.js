const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSession: () => ipcRenderer.invoke('session:get'),
  pickImages: () => ipcRenderer.invoke('images:pick'),
  processImages: (paths) => ipcRenderer.invoke('images:process', paths),
  updateCard: (id, changes, reviewed) => ipcRenderer.invoke('card:update', id, changes, reviewed),
  deleteCard: (id) => ipcRenderer.invoke('card:delete', id),
  clearCards: () => ipcRenderer.invoke('cards:clear'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  exportCsv: () => ipcRenderer.invoke('csv:export'),
  regenerateEmail: (id) => ipcRenderer.invoke('emails:regenerate', id),
  openLogin: (id) => ipcRenderer.invoke('login:open', id),
  check5sim: (token) => ipcRenderer.invoke('status:5sim', token),
  checkCapsolver: (key) => ipcRenderer.invoke('status:capsolver', key),
  reveal: (p) => ipcRenderer.invoke('file:reveal', p),
  imageData: (p) => ipcRenderer.invoke('image:data', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onProgress: (fn) => ipcRenderer.on('progress', (_e, p) => fn(p)),
});
