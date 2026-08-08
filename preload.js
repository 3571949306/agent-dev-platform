'use strict';
/**
 * Preload — exposes a typed, safe IPC bridge to the renderer.
 * contextIsolation = true, nodeIntegration = false. The renderer never uses
 * require('fs') / require('child_process'); it only calls window.api.* over IPC.
 */
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // generic request/response
  invoke(channel, ...args) { return ipcRenderer.invoke(channel, ...args); },
  // live agent events (tool calls, text, tasks, terminal, ...)
  onEvent(cb) {
    const f = (_e, payload) => cb(payload);
    ipcRenderer.on('agent:event', f);
    return () => ipcRenderer.removeListener('agent:event', f);
  },
  // permission confirmation requests from the runtime
  onPermission(cb) {
    const f = (_e, payload) => cb(payload);
    ipcRenderer.on('agent:permission-request', f);
    return () => ipcRenderer.removeListener('agent:permission-request', f);
  }
};

contextBridge.exposeInMainWorld('api', api);
