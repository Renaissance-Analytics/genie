import type { LocalFramePort } from '../core/local-frame.js';
import type { ClientTransport } from '../core/remote-protocol.js';

/** A window's ClientTransport over the one preload frame pair. */
export function localTransport(port: LocalFramePort): ClientTransport {
    const handle = globalThis.crypto.randomUUID();
    const messages = new Set<(text: string) => void>();
    const closes = new Set<() => void>();
    let closed = false;
    let offFrame = () => {};
    const finish = () => {
        if (closed) return;
        closed = true;
        offFrame();
        for (const listener of closes) listener();
        closes.clear();
        messages.clear();
    };
    offFrame = port.onFrame((action, connection, text) => {
        if (closed || connection !== handle) return;
        if (action === 'closed') finish();
        else for (const listener of messages) listener(text);
    });
    port.send('open', handle, '');
    return {
        send: (text) => { if (!closed) port.send('frame', handle, text); },
        onMessage: (listener) => { if (!closed) messages.add(listener); return () => { messages.delete(listener); }; },
        onClose: (listener) => { if (!closed) closes.add(listener); return () => { closes.delete(listener); }; },
        close: () => {
            if (closed) return;
            try { port.send('close', handle, ''); } finally { finish(); }
        },
    };
}

declare global { interface Window { genieLocalProtocol?: LocalFramePort } }
