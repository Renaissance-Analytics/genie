import type { LocalFramePort } from '../core/local-frame.js';
import type { ClientTransport } from '../core/remote-protocol.js';

/** Contract shell for the test-first door slice; no bridge methods use it. */
export function localTransport(_port: LocalFramePort): ClientTransport {
    return { send: () => {}, close: () => {}, onMessage: () => () => {}, onClose: () => () => {} };
}
