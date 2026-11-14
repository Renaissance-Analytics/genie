import { contextBridge, ipcRenderer } from 'electron';

/**
 * THE WAIT FOR GENIE'S HOST'S PRELOAD (Tynn #700). It exposes `genieHostWait`: the view to show (asked on load, pushed when
 * it changes) and the two actions, Open the log and Restart Genie's host. Nothing else of Genie.
 */
contextBridge.exposeInMainWorld('genieHostWait', {
    current: () => ipcRenderer.invoke('host-wait:current'),
    act: (action: 'open-log' | 'restart') => ipcRenderer.invoke('host-wait:act', action),
    onShow: (listener: (view: unknown) => void) => {
        const handler = (_e: unknown, view: unknown) => listener(view);
        ipcRenderer.on('host-wait:show', handler);
        return () => { ipcRenderer.removeListener('host-wait:show', handler); };
    },
});
