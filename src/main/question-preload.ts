import { contextBridge, ipcRenderer } from 'electron';

/**
 * THE FORCETHEQUESTION WINDOW'S PRELOAD. It exposes `genieQuestion` — the question to show (on load, and pushed when it
 * changes), an answer (the chosen labels and one note per question), Later, and Dismiss — and nothing else of Genie.
 */
contextBridge.exposeInMainWorld('genieQuestion', {
    current: () => ipcRenderer.invoke('question:current'),
    answer: (selections: string[][], notes: string[]) => ipcRenderer.invoke('question:answer', selections, notes),
    later: () => ipcRenderer.invoke('question:later'),
    dismiss: () => ipcRenderer.invoke('question:dismiss'),
    onShow: (listener: (view: unknown) => void) => {
        const handler = (_e: unknown, view: unknown) => listener(view);
        ipcRenderer.on('question:show', handler);
        return () => { ipcRenderer.removeListener('question:show', handler); };
    },
});
