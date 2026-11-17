const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('banner', { stop: () => ipcRenderer.send('overlay:stop'), hide: () => ipcRenderer.send('overlay:hide') });
