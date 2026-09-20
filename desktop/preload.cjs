// Preload bridge (sandboxed CommonJS): exposes a tiny, safe `window.pool` API to the viewer. The renderer never
// touches the filesystem/SQLite directly -- it hands plain data across IPC and the main process does the real work.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pool', {
  isDesktop: true,
  save:           (obj)      => ipcRenderer.invoke('pool:save', obj),          // -> {ok, path}
  load:           ()         => ipcRenderer.invoke('pool:load'),               // -> {ok, data, path}
  // File menu (main sends menu:<action> here; the renderer gathers live data + drives the write/import):
  onMenu:         (cb)       => ipcRenderer.on('menu:action', (_e, action) => cb(action)),   // 'exportSwimmer' | 'exportPool' | 'import'
  menuSelection:  (on)       => ipcRenderer.send('menu:selection', !!on),      // enable/disable "Export Swimmer" as selection changes
  exportSwimmer:  (obj)      => ipcRenderer.invoke('pool:exportSwimmer', obj),  // {..swimbot..} -> {ok, path}   (.gpswimmer.json)
  exportPool:     (obj)      => ipcRenderer.invoke('pool:exportPool', obj),     // {config, data} -> {ok, path}   (.pool)
  importPick:     ()         => ipcRenderer.invoke('pool:importPick'),          // open+read+validate a .pool -> {ok, config, data} | {ok:false, error?}
  // custom timelines (editable runs under ~/Documents/GenePool). open/saveAs return a run source like scrub.select.
  timeline: {
    open:   () => ipcRenderer.invoke('timeline:open'),                          // -> {ok, seed:null, custom:true, name, key, frontier, runConfig, lastHead}
    saveAs: () => ipcRenderer.invoke('timeline:saveAs'),                        // copy current run -> .timeline + switch into it (custom) -> same shape
  },
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
    commit:    (edit)  => ipcRenderer.invoke('scrub:commit', edit),            // {seed, field, value, tick} -> {ok, seed, frontier, runConfig, lastHead, error?}
    commitImport: (imp) => ipcRenderer.invoke('scrub:commitImport', imp),      // {seed, tick, config, data} -> branch the run at the playhead -> {ok, seed, frontier, runConfig, ...}
    frontier:  ()      => ipcRenderer.invoke('scrub:frontier'),               // -> int (max consistent tick, grows)
    keyframe:  (t)     => ipcRenderer.invoke('scrub:keyframe', t),            // -> {tick, snapshot} nearest <= t
    stats:     (t)     => ipcRenderer.invoke('scrub:stats', t),              // -> {tick, stats} nearest <= t
    popSeries: (opts)  => ipcRenderer.invoke('scrub:popSeries', opts),        // -> [{tick,pop,food}] downsampled
    reportHead:(key, head) => ipcRenderer.send('scrub:reportHead', { key, head }),   // persist per-source playhead across runs (fire-and-forget)
    onFrontier:(cb)    => ipcRenderer.on('scrub:frontier', (_e, msg) => cb(msg)),   // msg = { key, tick }
    onDone:    (cb)    => ipcRenderer.on('scrub:done', (_e, m) => cb(m)),
  },
});
