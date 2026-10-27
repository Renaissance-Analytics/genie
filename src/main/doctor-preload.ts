import { contextBridge, ipcRenderer } from 'electron';

/**
 * THE DOCTOR WINDOW'S PRELOAD (`genie --doctor`). It exposes `genieDoctor` — the OSA's detail, a prompt, start, an
 * approval answer, and a change signal — and never Genie's bridge, which doctor mode does not serve.
 */
contextBridge.exposeInMainWorld('genieDoctor', {
    facts: () => ipcRenderer.invoke('doctor:facts'),
    connect: () => ipcRenderer.invoke('doctor:connect'),
    detail: () => ipcRenderer.invoke('doctor:detail'),
    prompt: (text: string, files?: unknown) => ipcRenderer.invoke('doctor:prompt', text, files ?? []),
    start: () => ipcRenderer.invoke('doctor:start'),
    answerApproval: (optionId: string, note?: string) => ipcRenderer.invoke('doctor:answer-approval', optionId, note ?? ''),
    onChange: (listener: () => void) => {
        const handler = () => listener();
        ipcRenderer.on('doctor:changed', handler);
        return () => { ipcRenderer.removeListener('doctor:changed', handler); };
    },
});

// The doctor's chat draws copy buttons: they write through main (main/clipboard-ipc.ts).
// The channel is core/clipboard-wire.ts CLIPBOARD_WRITE_CHANNEL, written out: a module two preloads import becomes a shared
// chunk, and a sandboxed preload cannot require it (test/clipboard-main.test.ts holds this copy equal to the constant).
contextBridge.exposeInMainWorld('genieClipboard', {
    write: (text: string, html?: string) => ipcRenderer.invoke('genie:clipboard-write', html === undefined ? { text } : { text, html }) as Promise<boolean>,
});
