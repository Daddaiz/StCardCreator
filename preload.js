const { contextBridge, ipcRenderer } = require('electron');
// Ponte minimale verso SillyTavern: la pagina chiede, il processo principale esegue la richiesta HTTP.
contextBridge.exposeInMainWorld('stBridge', {
  request: req => ipcRenderer.invoke('st-request', req)
});
