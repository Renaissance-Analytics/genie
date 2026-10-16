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
    answerApproval: (optionId: string) => ipcRenderer.invoke('doctor:answer-approval', optionId),
    onChange: (listener: () => void) => {
        const handler = () => listener();
        ipcRenderer.on('doctor:changed', handler);
        return () => { ipcRenderer.removeListener('doctor:changed', handler); };
    },
});
