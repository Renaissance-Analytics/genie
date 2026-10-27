import { contextBridge, ipcRenderer } from 'electron';
import { clipboardBridge } from './clipboard-ipc.js';

/**
 * THE FORCETHEQUESTION WINDOW'S PRELOAD. It exposes `genieQuestion` — the question to show (on load, and pushed when it
 * changes), an answer (the chosen labels and one note per question), Later, and Dismiss (with the notes the person wrote) — and nothing else of Genie.
 * An answer and a Dismiss name the question they are for (the window holds a queue; any of it is answerable, in any
 * order); `select` picks one from the queue; `draft` hands main what is written so far, so a closed window loses nothing.
 */
// An id only when there is one: the channel's arguments stay exactly what they were for a call that names none.
const withId = (args: unknown[], id: string | undefined): unknown[] => (id === undefined ? args : [...args, id]);
contextBridge.exposeInMainWorld('genieQuestion', {
    current: () => ipcRenderer.invoke('question:current'),
    answer: (selections: string[][], notes: string[], id?: string) => ipcRenderer.invoke('question:answer', ...withId([selections, notes], id)),
    later: () => ipcRenderer.invoke('question:later'),
    dismiss: (notes: string[], id?: string) => ipcRenderer.invoke('question:dismiss', ...withId([notes], id)),
    select: (id: string) => ipcRenderer.invoke('question:select', id),
    draft: (id: string, draft: { selections: string[][]; notes: string[]; revision?: number }) => ipcRenderer.invoke('question:draft', id, draft),
    // Genie 1's file drawer: which named files are there, one file's text, and the window widening for it.
    files: (id: string, paths: string[]) => ipcRenderer.invoke('question:files', id, paths),
    file: (id: string, path: string) => ipcRenderer.invoke('question:file', id, path),
    drawer: (open: boolean) => ipcRenderer.invoke('question:drawer', open),
    onShow: (listener: (view: unknown) => void) => {
        const handler = (_e: unknown, view: unknown) => listener(view);
        ipcRenderer.on('question:show', handler);
        return () => { ipcRenderer.removeListener('question:show', handler); };
    },
});

// The question and its files are rendered Markdown with copy buttons: they write through main (main/clipboard-ipc.ts).
contextBridge.exposeInMainWorld('genieClipboard', clipboardBridge(ipcRenderer));
