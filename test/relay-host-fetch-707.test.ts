import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HostHttpsFetch, HostHttpsInit, HostHttpsResponse } from '../src/main/host-https-fetch.js';
import { relayFetchOver } from '../src/main/host-relay-fetch.js';
import { relayHostPorts, startRelayHost, type RelayHostStatus } from '../src/main/tynn-network.js';
import { fakeRelay, settle } from './relay-fake.js';

/*
 * A DRONE ON 61.x NEVER REACHED THE TYNN RELAY (Tynn issue #707; reproduced on an Azure Omarchy VM, 2026-11-12). genie-host
 * handed its HTTPS client to the relay's Tynn calls through two casts: the calls send no `signal`, and the client reads
 * `init.signal.aborted` first, so every relay ticket threw "Cannot read properties of undefined (reading 'aborted')"
 * before any connection; and the client's answer has `text()` but no `json()`, which those calls read. The status said
 * "Tynn could not be reached", nothing was logged, and the link never tried again. A 60.x drone upgraded to 61.2 vanished
 * from its Pilot's list.
 *
 * The fake client below behaves as host-https-fetch does on exactly those two points.
 */

const calls: Array<{ url: string; init: HostHttpsInit }> = [];
function strictSend(answer: (url: string) => { status: number; body: string; type?: string }): HostHttpsFetch {
    return async (url, init) => {
        if (init.signal.aborted) throw new Error('cancelled'); // as host-https-fetch.ts: a request without a signal throws here
        calls.push({ url, init });
        const { status, body, type } = answer(url);
        const res: HostHttpsResponse = {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (name) => (name.toLowerCase() === 'content-type' ? (type ?? 'application/json') : null) },
            text: async () => body,
        };
        return res;
    };
}
const tynn = (url: string) => {
    if (url.endsWith('/relay-ticket')) return { status: 200, body: JSON.stringify({ ticket: 't1', relay_endpoint: 'wss://relay.example.com' }) };
    if (url.endsWith('/grants/public-keys')) return { status: 200, body: JSON.stringify({ keys: [{ kid: 'k1', kty: 'OKP' }] }) };
    if (url.endsWith('/grants/introspect')) return { status: 200, body: JSON.stringify({ active: true }) };
    return { status: 404, body: '' };
};
const ports = (fetch: (url: string, init?: RequestInit) => Promise<Response>) =>
    relayHostPorts({ tynnHost: 'https://tynn.example.com/', workstationId: 'ws_me', authHeader: () => 'Workstation proof', fetch });

describe('the relay\'s Tynn calls, over genie-host\'s HTTPS client', () => {
    it('CONTROL: the cast genie-host used fails the way the reproduction logged', async () => {
        const cast = async (url: string, init?: RequestInit) => (await strictSend(tynn)(url, init as never)) as unknown as Response;
        await expect(ports(cast).ticket()).rejects.toThrow(/Tynn could not be reached \(Cannot read properties of undefined \(reading 'aborted'\)\)/);
    });

    it('a relay ticket is asked for with this machine\'s proof, and read', async () => {
        calls.length = 0;
        await expect(ports(relayFetchOver(strictSend(tynn))).ticket()).resolves.toEqual({ ticket: 't1', relayEndpoint: 'wss://relay.example.com' });
        const asked = calls.at(-1)!;
        expect(asked.url).toBe('https://tynn.example.com/api/v1/workstations/ws_me/relay-ticket');
        expect(asked.init.method).toBe('POST');
        expect(asked.init.headers.authorization).toBe('Workstation proof');
        expect(asked.init.credentials).toBe('omit');
        expect(asked.init.redirect).toBe('error');
        expect(asked.init.signal).toBeInstanceOf(AbortSignal);
    });

    it('Tynn\'s grant keys and introspection are read too', async () => {
        const p = ports(relayFetchOver(strictSend(tynn)));
        await expect(p.keys()).resolves.toEqual([{ kid: 'k1', kty: 'OKP' }]);
        await expect(p.introspect('grant')).resolves.toBe(true);
        expect(calls.at(-1)!.init.body).toBe(JSON.stringify({ token: 'grant' }));
    });

    it('a refusal keeps Tynn\'s status and words; an answer with no body is not an error of its own', async () => {
        const refusing = relayFetchOver(strictSend(() => ({ status: 403, body: JSON.stringify({ message: 'This workstation may not use the relay.' }) })));
        await expect(ports(refusing).ticket()).rejects.toThrow('This workstation may not use the relay.');
        const empty = await relayFetchOver(strictSend(() => ({ status: 204, body: '' })))('https://tynn.example.com/x');
        expect(empty.status).toBe(204);
    });

    it('genie-host builds the relay\'s fetch with relayFetchOver, never a cast', () => {
        const host = readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8');
        expect(host).toMatch(/relayFetchOver\(/);
        expect(host).not.toMatch(/as unknown as Response/);
    });
});

describe('a relay link whose first ticket fails', () => {
    const hostKey = generateKeyPairSync('ed25519');
    const fingerprint = createHash('sha256').update(hostKey.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

    it('says why in the log, tries again by itself, and becomes reachable when Tynn answers', async () => {
        const relay = fakeRelay(() => 'ws_me');
        let asks = 0;
        const lines: string[] = [];
        const statuses: RelayHostStatus[] = [];
        const host = startRelayHost({
            ports: {
                ticket: async () => { asks += 1; if (asks === 1) throw new Error('Tynn could not be reached (offline)'); return { ticket: 't1', relayEndpoint: 'wss://relay.example.com' }; },
                keys: async () => [],
                introspect: async () => false,
            },
            socket: relay.socket,
            workstationId: 'ws_me',
            fingerprint,
            sign: (d) => sign(null, d, hostKey.privateKey),
            onStatus: (s) => statuses.push(s),
            log: (line) => lines.push(line),
            reconnect: { minMs: 0, maxMs: 0 },
            ticketRetry: { minMs: 0, maxMs: 0 },
        } as Parameters<typeof startRelayHost>[0]);
        await settle();
        await settle();
        expect(lines.some((l) => /unavailable: Tynn could not be reached \(offline\)/.test(l))).toBe(true);
        expect(statuses).toContainEqual({ state: 'unavailable', reason: 'Tynn could not be reached (offline)' });
        expect(asks).toBe(2);
        expect(host.status()).toEqual({ state: 'reachable', relay: 'wss://relay.example.com' });
        host.stop();
    });

    it('stop() ends the retrying: no ticket is asked for after it', async () => {
        let asks = 0;
        const host = startRelayHost({
            ports: { ticket: async () => { asks += 1; throw new Error('Tynn could not be reached (offline)'); }, keys: async () => [], introspect: async () => false },
            socket: fakeRelay(() => 'ws_me').socket,
            workstationId: 'ws_me',
            fingerprint,
            sign: (d) => sign(null, d, hostKey.privateKey),
            reconnect: { minMs: 0, maxMs: 0 },
            ticketRetry: { minMs: 20, maxMs: 20 },
        } as Parameters<typeof startRelayHost>[0]);
        await settle();
        host.stop();
        const before = asks;
        await new Promise((r) => setTimeout(r, 80));
        expect(asks).toBe(before);
    });
});
