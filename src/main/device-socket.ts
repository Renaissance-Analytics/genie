import WebSocket from 'ws';
import { DEVICE_FRAME_LIMIT_BYTES, type DeviceSocket } from './device-link-service.js';
import { rootsOfThisMachine } from './host-https-fetch.js';

/**
 * THE SOCKET TO ANOTHER MACHINE (P3.4 cut e). It trusts what the host's HTTPS trusts: Node's bundled roots and the OS store, from the one function that reads them. Chromium
 * read the OS store for a window and Node's own WebSocket does not, so a machine behind a company's root would have stopped answering. Hence `ws`, which takes the set.
 *
 * VERIFICATION IS NEVER OFF: `rejectUnauthorized: true` is explicit, so an inherited NODE_TLS_REJECT_UNAUTHORIZED=0 changes nothing. No redirect is followed: a token goes to
 * the address it was minted by. Genie's CA counts only once it is in the OS store. No proxy: these machines are reached directly, as a window reached them over the tailnet.
 */
export function deviceSocket(url: string, options: { readonly machineRoots?: () => readonly string[]; readonly maxPayload?: number } = {}): DeviceSocket {
    const socket = new WebSocket(url, { ca: [...(options.machineRoots ?? rootsOfThisMachine)()], rejectUnauthorized: true, followRedirects: false, maxPayload: options.maxPayload ?? DEVICE_FRAME_LIMIT_BYTES });
    // ws emits `error` when a socket is closed mid-dial, and an emitter with no listener throws: giving up on a machine must not take the host with it.
    socket.on('error', () => {});
    return socket as unknown as DeviceSocket;
}
