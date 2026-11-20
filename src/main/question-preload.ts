import { contextBridge, ipcRenderer } from 'electron';

/**
 * THE FORCETHEQUESTION WINDOW'S PRELOAD. It exposes `genieQuestion` — the window's own calls: the question to show (on
 * load, and pushed when it changes), Later, a pick from the queue (`select`), the draft written so far (`draft`, so a
 * closed window loses nothing), Open in Files and the drawer's width — and `remote`, for ANOTHER machine's question, which
 * goes back through the window driving that machine (Tynn #726). And `genieLocalProtocol`, the one frame port: this
 * machine's answer, Dismiss, files and visuals go to genie-host over it, like any Genie window's (Tynn #912, 2f-1;
 * renderer/question-bridge.ts). Nothing else of Genie.
 */
contextBridge.exposeInMainWorld('genieQuestion', {
    current: () => ipcRenderer.invoke('question:current'),
    later: () => ipcRenderer.invoke('question:later'),
    select: (id: string) => ipcRenderer.invoke('question:select', id),
    draft: (id: string, draft: { selections: string[][]; notes: string[]; revision?: number }) => ipcRenderer.invoke('question:draft', id, draft),
    // Another machine's question: { kind: 'answer' | 'dismiss' | 'visuals', id, selections?, notes? } (main/remote-questions.ts).
    remote: (request: unknown) => ipcRenderer.invoke('question:remote', request),
    openInFiles: (id: string, path: string) => ipcRenderer.invoke('question:open-in-files', id, path),
    drawer: (open: boolean) => ipcRenderer.invoke('question:drawer', open),
    onShow: (listener: (view: unknown) => void) => {
        const handler = (_e: unknown, view: unknown) => listener(view);
        ipcRenderer.on('question:show', handler);
        return () => { ipcRenderer.removeListener('question:show', handler); };
    },
});

// THE ONE FRAME PORT (core/local-frame.ts LOCAL_FRAME_CHANNELS, written out: a module two sandboxed preloads share becomes a
// chunk neither can require; split-2f-question-window.test.ts holds these equal to the constant). Admission is main's.
contextBridge.exposeInMainWorld('genieLocalProtocol', {
    send: (action: string, connection: string, text: string) => {
        if (typeof action !== 'string' || typeof connection !== 'string' || typeof text !== 'string') throw new TypeError('the local protocol port accepts strings only');
        ipcRenderer.send('genie:local-frame', action, connection, text);
    },
    onFrame: (listener: (action: 'frame' | 'closed', connection: string, text: string) => void) => {
        const onFrame = (_event: unknown, action: unknown, connection: unknown, text: unknown): void => {
            if ((action === 'frame' || action === 'closed') && typeof connection === 'string' && typeof text === 'string') listener(action, connection, text);
        };
        ipcRenderer.on('genie:local-frame-back', onFrame);
        return () => { ipcRenderer.removeListener('genie:local-frame-back', onFrame); };
    },
});

// The question and its files are rendered Markdown with copy buttons: they write through main (main/clipboard-ipc.ts).
// The channel is core/clipboard-wire.ts CLIPBOARD_WRITE_CHANNEL, written out: a module two preloads import becomes a shared
// chunk, and a sandboxed preload cannot require it (test/clipboard-main.test.ts holds this copy equal to the constant).
contextBridge.exposeInMainWorld('genieClipboard', {
    write: (text: string, html?: string) => ipcRenderer.invoke('genie:clipboard-write', html === undefined ? { text } : { text, html }) as Promise<boolean>,
});
