import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DRONE_MIN_BUILD, compareVersions, refusalSkew, skewSentence, welcomeSkew } from '../src/core/drone-version.js';
import { relayConnectView } from '../src/core/relay-connect.js';
import { inMemoryPair, parseMessage, REMOTE_PROTOCOL, type ServerConnection } from '../src/core/remote-protocol.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { RelayConnecting } from '../src/renderer/components/RelayConnecting.js';

/*
 * A PILOT CONNECTING TO A DRONE ON AN OLDER GENIE SAYS SO (Tynn #651; the owner's screenshot, 2026-11-12). A 61.2 Pilot
 * connecting to drone "aion" stopped at "Open aion's Genie" with `"host.home" is not a bridge method` and Retry: aion
 * ran beta.60, which has no `host.home` (it arrived in beta.61, 104b37aa), and its validator refuses a method it does not
 * know. The connect screen names the skew — aion's build, the build to update it to, the plain steps — never the raw
 * protocol error.
 */

/**
 * A FAKE OLDER DRONE: the server end of the in-memory pair, speaking as beta.60 did. Its welcome carries what `welcome`
 * says (an older one may carry no build or protocol at all); a call to a method it does not know is refused the way
 * beta.60's validator refused it (main/remote-host.ts `#onFrame`: a `refused` frame, no result, the socket kept).
 */
function olderDrone(welcome: Record<string, unknown>, unknown: readonly string[] = ['host.home']) {
    const { client, server } = inMemoryPair();
    const calls: string[] = [];
    let closed = false;
    server.onClose(() => { closed = true; });
    server.onMessage((text) => {
        const raw = JSON.parse(text) as { kind: string; id?: number; method?: string };
        if (raw.kind === 'hello') { server.send(JSON.stringify({ kind: 'welcome', connectionId: 'c1', host: 'aion', isOwner: true, workspaceId: null, ...welcome })); return; }
        if (raw.kind !== 'call') return;
        calls.push(raw.method!);
        if (unknown.includes(raw.method!)) { server.send(JSON.stringify({ kind: 'refused', reason: `"${raw.method}" is not a bridge method` })); return; }
        server.send(JSON.stringify({ kind: 'result', id: raw.id, ok: true, value: raw.method === 'baton.status' ? { driver: null, mine: true, locked: false } : { ok: true } }));
    });
    return { client, server: server as ServerConnection, calls, closed: () => closed };
}

describe('the drone’s build against what this Pilot needs', () => {
    it('the minimum is the first build with host.home', () => {
        expect(DRONE_MIN_BUILD).toBe('2.0.0-beta.61');
    });

    it('compares prerelease builds by their numbers, a release above its prereleases', () => {
        expect(compareVersions('2.0.0-beta.60', '2.0.0-beta.61')).toBeLessThan(0);
        expect(compareVersions('2.0.0-beta.61.2', '2.0.0-beta.61')).toBeGreaterThan(0);
        expect(compareVersions('2.0.0-beta.9', '2.0.0-beta.10')).toBeLessThan(0);
        expect(compareVersions('2.0.0', '2.0.0-beta.99')).toBeGreaterThan(0);
        expect(compareVersions('2.0.0-beta.61', '2.0.0-beta.61')).toBe(0);
    });

    it('a welcome with no build is older', () => {
        const bare: Record<string, unknown> = { connectionId: 'c', host: 'aion', isOwner: true };
        expect(welcomeSkew(bare)).toEqual({ build: null });
        expect(welcomeSkew({ protocol: REMOTE_PROTOCOL })).toEqual({ build: null });
    });

    it('a welcome with no protocol is older, whatever build it says', () => {
        expect(welcomeSkew({ build: '2.0.0-beta.61.2' })).toEqual({ build: '2.0.0-beta.61.2' });
    });

    it('beta.60 is older; its host hash is not part of the build shown', () => {
        expect(welcomeSkew({ protocol: 1, build: '2.0.0-beta.60+0123456789ab' })).toEqual({ build: '2.0.0-beta.60' });
    });

    it('beta.61 and later are not older', () => {
        expect(welcomeSkew({ protocol: 1, build: '2.0.0-beta.61' })).toBeNull();
        expect(welcomeSkew({ protocol: 1, build: '2.0.0-beta.61.2+abc' })).toBeNull();
        expect(welcomeSkew({ protocol: 1, build: '2.0.0' })).toBeNull();
    });

    it('a dev build cannot be placed and is not called older', () => {
        expect(welcomeSkew({ protocol: 1, build: 'dev' })).toBeNull();
    });

    it('a refusal naming an unknown method is version skew; any other refusal is not', () => {
        expect(refusalSkew('"host.home" is not a bridge method')).toEqual({ method: 'host.home' });
        expect(refusalSkew('take the baton first')).toBeNull();
        expect(refusalSkew('say hello first')).toBeNull();
    });
});

describe('the connect screen names the skew', () => {
    it('says the drone’s build and the Pilot’s, with the steps, never the protocol error', () => {
        const view = relayConnectView('aion', { kind: 'failed', step: 'host', reason: '"host.home" is not a bridge method', skew: { drone: '2.0.0-beta.60', pilot: '2.0.0-beta.61.2' } });
        expect(view.problem).toContain('aion runs Genie 2.0.0-beta.60. Update it to 2.0.0-beta.61.2 or later.');
        expect(view.problem).toContain('Check for updates');
        expect(view.problem).not.toContain('bridge method');
        expect(view.steps.map((s) => s.status)).toEqual(['done', 'done', 'failed']);
    });

    it('a drone that said no build is "an older Genie"', () => {
        expect(skewSentence('aion', { drone: null, pilot: '2.0.0-beta.61.2' })).toContain('aion runs an older Genie. Update it to 2.0.0-beta.61.2 or later.');
    });

    it('the screen shows it with a real Retry button', () => {
        const html = renderToStaticMarkup(createElement(RelayConnecting, { name: 'aion', state: { kind: 'failed', step: 'host', reason: '"host.home" is not a bridge method', skew: { drone: '2.0.0-beta.60', pilot: '2.0.0-beta.61.2' } }, onRetry: () => {} }));
        expect(html).toContain('aion runs Genie 2.0.0-beta.60');
        expect(html).not.toContain('bridge method');
        expect(html).toMatch(/<button[^>]*data-action="retry-connect"/);
    });
});

describe('connectRemote against a fake older drone', () => {
    it('a welcome without a build: not connected, the skew said, the link closed', async () => {
        const drone = olderDrone({});
        const client = connectRemote(drone.client, { kind: 'relay', label: 'pilot' }, 'pilot', { drive: true, minBuild: DRONE_MIN_BUILD });
        const r = await client.ready;
        expect(r).toMatchObject({ ok: false, skew: { build: null } });
        if (!r.ok) expect(r.reason).not.toContain('bridge method');
        expect(client.state().connected).toBe(false);
        await vi.waitFor(() => expect(drone.closed()).toBe(true));
        // Nothing was asked of a drone that cannot answer it.
        expect(drone.calls).toEqual([]);
    });

    it('beta.60’s welcome: its build is the skew', async () => {
        const drone = olderDrone({ protocol: 1, build: '2.0.0-beta.60+0123456789ab' });
        const client = connectRemote(drone.client, { kind: 'relay', label: 'pilot' }, 'pilot', { minBuild: DRONE_MIN_BUILD });
        expect(await client.ready).toMatchObject({ ok: false, skew: { build: '2.0.0-beta.60' } });
    });

    it('a new enough drone connects as before, and its build is kept', async () => {
        const drone = olderDrone({ protocol: 1, build: '2.0.0-beta.61.2+abc' }, []);
        const client = connectRemote(drone.client, { kind: 'relay', label: 'pilot' }, 'pilot', { minBuild: DRONE_MIN_BUILD });
        expect(await client.ready).toEqual({ ok: true });
        expect(client.state()).toMatchObject({ connected: true, hostBuild: '2.0.0-beta.61.2+abc' });
        client.close();
    });

    it('the fallback: a call refused as "not a bridge method" after welcome is the skew, and the link closes', async () => {
        // A build that passed the check and still lacks a method this Pilot calls (the minimum was not raised with it).
        const drone = olderDrone({ protocol: 1, build: '2.0.0-beta.61' }, ['host.home']);
        const client = connectRemote(drone.client, { kind: 'relay', label: 'pilot' }, 'pilot', { minBuild: DRONE_MIN_BUILD });
        expect(await client.ready).toEqual({ ok: true });
        // Nothing this path leaves behind rejects with nobody listening (the Deck's raw "unhandled rejection", #636).
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
        process.on('unhandledRejection', onUnhandled);
        try {
            // The caller listens from the moment it asks, as the window's caller does (host-home.ts catches): the read ends
            // with the link, in this bridge's words for any closed link.
            const home = expect(client.bridge.host!.home!()).rejects.toThrow('the connection closed');
            await vi.waitFor(() => expect(client.state()).toMatchObject({ connected: false, skew: { build: '2.0.0-beta.61', method: 'host.home' } }));
            await home;
            expect(drone.closed()).toBe(true);
            expect(client.state().lastRefusal ?? '').not.toContain('bridge method');
            await new Promise<void>((r) => setImmediate(r));
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });

    it('the same refusal before the welcome resolves ready with the skew', async () => {
        const { client: end, server } = inMemoryPair();
        server.onMessage((text) => {
            const m = parseMessage(text);
            if (m.ok && m.message.kind === 'hello') server.send(JSON.stringify({ kind: 'refused', reason: '"host.home" is not a bridge method' }));
        });
        const client = connectRemote(end, { kind: 'relay', label: 'pilot' }, 'pilot', { minBuild: DRONE_MIN_BUILD });
        expect(await client.ready).toMatchObject({ ok: false, skew: { build: null, method: 'host.home' } });
    });

    it('without minBuild a client connects to any drone as it always did', async () => {
        const drone = olderDrone({});
        const client = connectRemote(drone.client, { kind: 'relay', label: 'pilot' }, 'pilot');
        expect(await client.ready).toEqual({ ok: true });
        client.close();
    });
});

describe('the window wires it', () => {
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    it('a Tynn workstation’s connection asks for the minimum build', () => {
        expect(app).toMatch(/minBuild: DRONE_MIN_BUILD/);
    });
    it('a skew is said at the host step with the Pilot’s own build', () => {
        expect(app).toMatch(/skew: \{ drone: [^}]*pilot: /);
    });
});
