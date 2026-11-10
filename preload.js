const { contextBridge, ipcRenderer } = require('electron');
// Ponte minimale verso SillyTavern: la pagina chiede, il processo principale esegue la richiesta HTTP.
contextBridge.exposeInMainWorld('stBridge', {
  request: req => ipcRenderer.invoke('st-request', req),
  // Download dei checkpoint per Stable Diffusion: scelta cartella, avvio, annullamento, avanzamento
  saveBackup: o => ipcRenderer.invoke('save-backup', o),
  pickDir: () => ipcRenderer.invoke('pick-dir'),
  download: o => ipcRenderer.invoke('dl-start', o),
  cancelDownload: id => ipcRenderer.invoke('dl-cancel', id),
  onDownload: cb => ipcRenderer.on('dl-progress', (e, d) => cb(d))
});
