const { contextBridge, ipcRenderer } = require('electron');
// Ponte minimale verso SillyTavern: la pagina chiede, il processo principale esegue la richiesta HTTP.
contextBridge.exposeInMainWorld('stBridge', {
  request: req => ipcRenderer.invoke('st-request', req),
  // Download dei checkpoint per Stable Diffusion: scelta cartella, avvio, annullamento, avanzamento
  saveBackup: o => ipcRenderer.invoke('save-backup', o),
  pickDir: () => ipcRenderer.invoke('pick-dir'),
  download: o => ipcRenderer.invoke('dl-start', o),
  cancelDownload: id => ipcRenderer.invoke('dl-cancel', id),
  onDownload: cb => ipcRenderer.on('dl-progress', (e, d) => cb(d)),
  // Qwen Image 2.1 in locale
  qwenInfo: () => ipcRenderer.invoke('qwen-info'),
  qwenOpenDir: () => ipcRenderer.invoke('qwen-open-dir'),
  qwenDownload: o => ipcRenderer.invoke('qwen-dl', o),
  qwenInstall: o => ipcRenderer.invoke('qwen-sdcli', o),
  qwenPickSdCli: () => ipcRenderer.invoke('qwen-pick-sdcli'),
  qwenForgetSdCli: () => ipcRenderer.invoke('qwen-forget-sdcli'),
  qwenGenerate: o => ipcRenderer.invoke('qwen-gen', o),
  qwenCancel: id => ipcRenderer.invoke('qwen-cancel', id),
  saveImage: o => ipcRenderer.invoke('save-image', o),
  showImage: f => ipcRenderer.invoke('show-image', f),
  onQwen: cb => ipcRenderer.on('qwen-progress', (e, d) => cb(d))
});
