import { contextBridge, ipcRenderer } from 'electron';

/**
 * THE FORCETHEQUESTION WINDOW'S PRELOAD. It exposes `genieQuestion` — the question to show (on load, and pushed when it
 * changes), an answer, and Later — and nothing else of Genie.
 */
contextBridge.exposeInMainWorld('genieQuestion', {
    current: () => ipcRenderer.invoke('question:current'),
    answer: (selections: string[][], note: string) => ipcRenderer.invoke('question:answer', selections, note),
    later: () => ipcRenderer.invoke('question:later'),
    onShow: (listener: (view: unknown) => void) => {
        const handler = (_e: unknown, view: unknown) => listener(view);
        ipcRenderer.on('question:show', handler);
        return () => { ipcRenderer.removeListener('question:show', handler); };
    },
});
