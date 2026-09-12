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
  saveParams:     (obj)      => ipcRenderer.invoke('params:save', obj),        // K-panel: persist to a userData file (localStorage is lost across launches -- ephemeral port -> new origin)
  loadParams:     ()         => ipcRenderer.invoke('params:load'),             // -> saved params object | null
  saveVideo:      (bytes, ext) => ipcRenderer.invoke('video:save', { bytes, ext }),   // video bytes + ext (mp4/webm) -> a date/time-named file in ~/Movies/GenePool -> {ok, path}
  // scrub/playback: pick a seed (main starts/continues its run generator), then read the run back for playback.
  scrub: {
    select:    (seed)  => ipcRenderer.invoke('scrub:select', seed),            // -> {ok, seed, frontier, runConfig}
    frontier:  ()      => ipcRenderer.invoke('scrub:frontier'),               // -> int (max consistent tick, grows)
    keyframe:  (t)     => ipcRenderer.invoke('scrub:keyframe', t),            // -> {tick, snapshot} nearest <= t
    stats:     (t)     => ipcRenderer.invoke('scrub:stats', t),              // -> {tick, stats} nearest <= t
    popSeries: (opts)  => ipcRenderer.invoke('scrub:popSeries', opts),        // -> [{tick,pop,food}] downsampled
    reportHead:(seed, head) => ipcRenderer.send('scrub:reportHead', { seed, head }),   // persist per-seed playhead across runs (fire-and-forget)
    onFrontier:(cb)    => ipcRenderer.on('scrub:frontier', (_e, msg) => cb(msg)),   // msg = { seed, tick }
    onDone:    (cb)    => ipcRenderer.on('scrub:done', (_e, m) => cb(m)),
  },
});
