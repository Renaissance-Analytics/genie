import { contextBridge, ipcRenderer } from 'electron';

/**
 * THE HOST DIRECTORY'S PRELOAD (Tynn #1058 L4). It exposes `genieHostDirectory`: the state to show (asked on load, pushed
 * when it changes) and the directory's actions (Start, Open log, Add a host). Nothing else of Genie.
 */
contextBridge.exposeInMainWorld('genieHostDirectory', {
    current: () => ipcRenderer.invoke('host-directory:current'),
    act: (action: 'start' | 'open-log' | 'add-host') => ipcRenderer.invoke('host-directory:act', action),
    onShow: (listener: (state: unknown) => void) => {
        const handler = (_e: unknown, state: unknown) => listener(state);
        ipcRenderer.on('host-directory:show', handler);
        return () => { ipcRenderer.removeListener('host-directory:show', handler); };
    },
});
