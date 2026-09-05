// Preload bridge (sandboxed CommonJS): exposes a tiny, safe `window.pool` API to the viewer. The renderer never
// touches the filesystem/SQLite directly -- it hands plain data across IPC and the main process does the real work.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pool', {
  isDesktop: true,
  save:           (obj)      => ipcRenderer.invoke('pool:save', obj),          // -> {ok, path}
  load:           ()         => ipcRenderer.invoke('pool:load'),               // -> {ok, data, path}
  recordStart:    (opts)     => ipcRenderer.invoke('pool:recordStart', opts),  // {seed, config, snapshot} -> {ok, path}
  record:         (events)   => ipcRenderer.send('pool:record', events),       // fire-and-forget event batch
  recordSnapshot: (snapshot) => ipcRenderer.invoke('pool:recordSnapshot', snapshot),
  recordStop:     ()         => ipcRenderer.invoke('pool:recordStop'),         // -> {ok, path, events}
});
