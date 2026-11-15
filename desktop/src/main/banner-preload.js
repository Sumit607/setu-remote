const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('banner', { stop: () => ipcRenderer.send('overlay:stop') });
