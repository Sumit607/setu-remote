const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = ch => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('native', {
  state: call('state'), saveStore: call('store:save'), qr: call('qr'),
  fsList: call('fs:list'), fsOpenRead: call('fs:openRead'), fsRead: call('fs:read'), fsOpenWrite: call('fs:openWrite'),
  fsWrite: call('fs:write'), fsClose: call('fs:close'), fsExists: call('fs:exists'), fsMkdir: call('fs:mkdir'),
  pickFiles: call('pick:files'), pickFolder: call('pick:folder'), reveal: call('reveal'), openPath: call('open'),
  clipGet: call('clip:get'), clipSet: call('clip:set'), notify: call('notify'), turnIce: call('turn:ice'), screenSource: call('screen:source'),
  overlay: call('overlay'), autostart: call('autostart'), cursor: call('cursor'), cursorRel: call('cursor:rel'), injectStatus: call('inject:status'),
  lockState: call('lock:state'), pcLock: call('pc:lock'), unlockStatus: call('unlock:status'), unlockSetup: call('unlock:setup'), unlockRemove: call('unlock:remove'), unlockNow: call('unlock:now'), testLock: call('test:lock'),
  updateState: call('update:state'), updateCheck: call('update:check'), updateInstall: call('update:install'),
  inject: ev => ipcRenderer.send('inject', ev),
  pathOf: file => webUtils.getPathForFile(file),
  on: (ch, f) => ipcRenderer.on(ch, (_e, ...a) => f(...a)),
});
