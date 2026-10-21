import { contextBridge, ipcRenderer } from 'electron';

/**
 * THE GENIE BROWSER WINDOW'S PRELOAD — for the CHROME only (the sites' own pages get no preload and no bridge). It exposes
 * `genieBrowser`: the snapshot (asked on load, pushed on every change), the page box's bounds, and the chrome's calls —
 * and nothing else of Genie. Main knows which window a call came from by its sender.
 */
contextBridge.exposeInMainWorld('genieBrowser', {
    state: () => ipcRenderer.invoke('browser-window:state'),
    navigate: (address: string) => ipcRenderer.invoke('browser-window:navigate', address),
    open: (address: string) => ipcRenderer.invoke('browser-window:open', address),
    newTab: () => ipcRenderer.invoke('browser-window:new-tab'),
    activate: (id: string) => ipcRenderer.invoke('browser-window:activate', id),
    close: (id: string) => ipcRenderer.invoke('browser-window:close', id),
    back: () => ipcRenderer.invoke('browser-window:back'),
    forward: () => ipcRenderer.invoke('browser-window:forward'),
    reload: () => ipcRenderer.invoke('browser-window:reload'),
    setPreset: (id: string) => ipcRenderer.invoke('browser-window:preset', id),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke('browser-window:bounds', bounds),
    // The native buttons sit over the title row on Windows and Linux; macOS draws its own traffic lights.
    overlay: process.platform !== 'darwin',
    setOverlayColors: (color: string, symbolColor: string) => ipcRenderer.invoke('browser-window:overlay-colors', color, symbolColor),
    onState: (listener: (snapshot: unknown) => void) => {
        const handler = (_e: unknown, snapshot: unknown) => listener(snapshot);
        ipcRenderer.on('browser-window:state', handler);
        return () => { ipcRenderer.removeListener('browser-window:state', handler); };
    },
});
