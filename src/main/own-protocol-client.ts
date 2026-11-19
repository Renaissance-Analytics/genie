import { remoteOffer } from '../core/protocol-version.js';
import { inMemoryPair, parseMessage, type PreAuth, type RemoteMethod, type ServerConnection, type ServerTransport } from '../core/remote-protocol.js';

/**
 * MAIN'S OWN PROTOCOL CLIENT (client/host split step 2b-2b, Tynn #898, story #896). What main itself asks of the host
 * (the tray's Log in, its Claude Design login, and later its scratch terminal) goes over the one protocol, like any
 * other client: a client is a dumb terminal, and genie-host answers.
 *
 * Each call is one connection: hello, welcome, one call, its result, close. The connection is opened on `door`, an
 * in-process transport that main tunnels over its engine link (window-tunnel.ts tunnelDoor) exactly as it tunnels its
 * window's IPC door, so genie-host's RemoteHost admits it as this machine's own window, labelled Genie's tray. The
 * door listens on nothing: it has no address, and a connection exists only while main is making a call.
 */
export const OWN_CLIENT_LABEL = 'Genie’s tray';

export type OwnCallAnswer = { ok: true; value: unknown } | { ok: false; reason: string };

export interface OwnProtocolClient {
    /** Tunnelled by main over its engine link; never a listener. */
    readonly door: ServerTransport;
    call(method: RemoteMethod, args: unknown[]): Promise<OwnCallAnswer>;
}

/**
 * Why a call did not do what it asked, in words; null = it did. A refused call, or an answer that itself says
 * `{ ok: false, reason }` (a sign-in the host could not start).
 */
export function callRefusal(answer: OwnCallAnswer): string | null {
    if (!answer.ok) return answer.reason;
    const value = answer.value as { ok?: unknown; reason?: unknown } | null;
    if (value && typeof value === 'object' && value.ok === false) return typeof value.reason === 'string' ? value.reason : 'refused';
    return null;
}

const NOT_READY ='Genie is still starting; try again in a moment';
const PRE_AUTH: PreAuth = { kind: 'local', label: OWN_CLIENT_LABEL, isOwner: true, workspaceId: null, readonly: false, window: 'main' };

export function ownProtocolClient(options: { timeoutMs?: number } = {}): OwnProtocolClient {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const listeners = new Set<(connection: ServerConnection) => void>();
    const door: ServerTransport = {
        onConnection: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const call = (method: RemoteMethod, args: unknown[]): Promise<OwnCallAnswer> => {
        if (listeners.size === 0) return Promise.resolve({ ok: false, reason: NOT_READY });
        const pair = inMemoryPair();
        const client = pair.client;
        return new Promise<OwnCallAnswer>((resolve) => {
            let done = false;
            const finish = (answer: OwnCallAnswer) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(answer);
                client.close();
            };
            const timer = setTimeout(() => finish({ ok: false, reason: `${method} got no answer from Genie in time` }), timeoutMs);
            client.onClose(() => finish({ ok: false, reason: NOT_READY }));
            client.onMessage((text) => {
                const parsed = parseMessage(text);
                if (!parsed.ok) return;
                const message = parsed.message;
                if (message.kind === 'refused') return finish({ ok: false, reason: message.reason });
                if (message.kind === 'welcome') {
                    if (message.compatible === false) return finish({ ok: false, reason: message.reason ?? 'this Genie and its host do not speak the same protocol' });
                    client.send(JSON.stringify({ kind: 'call', id: 1, method, args }));
                    return;
                }
                if (message.kind === 'result' && message.id === 1) finish(message.ok ? { ok: true, value: message.value } : { ok: false, reason: message.reason });
                // Events the host pushes to a new connection are not this call's: ignored.
            });
            const server: ServerConnection = { ...pair.server, remoteAddress: 'genie-tray', preAuth: PRE_AUTH };
            for (const listener of [...listeners]) listener(server);
            const offer = remoteOffer('client');
            client.send(JSON.stringify({
                kind: 'hello', auth: { kind: 'local' }, label: OWN_CLIENT_LABEL,
                ...(offer.track ? { track: offer.track } : {}), ...(offer.build ? { build: offer.build } : {}),
                schema: offer.schema, minSchema: offer.minSchema, capabilities: offer.capabilities,
            }));
        });
    };
    return { door, call };
}
