import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CloneOffer } from '../src/core/clone-offers.js';
import { capabilityOf, WORKSPACE_SCOPED_METHODS } from '../src/core/remote-protocol.js';
import { CloneOffersService } from '../src/main/clone-offers-service.js';
import { HOST_WORKSPACE_LIFECYCLE_METHODS } from '../src/main/host-alone-api.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';

/**
 * THE OFFERS, REACHABLE (Tynn #756, the offers UI): two bridge methods, `workspaces.cloneOffers` (a read) and `workspaces.applyOffer`
 * (a write), the owner's only, answered by genie-host, which owns the watcher: a window reaches it through the engine link the way
 * it reaches the flow store and the process book. A guest of a shared workspace is refused. Fixtures: invented names.
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const offer: CloneOffer = { id: 'flow:.flows/a.json', kind: 'flow', file: '.flows/a.json', change: 'new', summary: 'New flow: a', incoming: { v: 1 }, local: null };

describe('the protocol', () => {
    it('listing is a read and applying a write, both scoped to the workspace they name', () => {
        expect(capabilityOf('workspaces.cloneOffers')).toBe('read');
        expect(capabilityOf('workspaces.applyOffer')).toBe('write');
        expect(WORKSPACE_SCOPED_METHODS).toContain('workspaces.cloneOffers');
        expect(WORKSPACE_SCOPED_METHODS).toContain('workspaces.applyOffer');
    });

    it('genie-host answers both while no window is connected', () => {
        expect(HOST_WORKSPACE_LIFECYCLE_METHODS.has('workspaces.cloneOffers')).toBe(true);
        expect(HOST_WORKSPACE_LIFECYCLE_METHODS.has('workspaces.applyOffer')).toBe(true);
    });

    it('the host API hands the workspace id, and the offer id, to the workspace ops; a host without them refuses in words', async () => {
        const calls: unknown[][] = [];
        const ops = {
            cloneOffers: async (id: string) => { calls.push(['list', id]); return { ok: true, offers: [offer], trusted: true }; },
            applyOffer: async (id: string, offerId: string) => { calls.push(['apply', id, offerId]); return { ok: true }; },
        };
        const api = buildHostApi({ workspaceOps: ops } as unknown as HostApiDeps);
        expect(await api.invoke('workspaces.cloneOffers', ['acme'])).toEqual({ ok: true, offers: [offer], trusted: true });
        expect(await api.invoke('workspaces.applyOffer', ['acme', offer.id])).toEqual({ ok: true });
        expect(calls).toEqual([['list', 'acme'], ['apply', 'acme', offer.id]]);
        const bare = buildHostApi({ workspaceOps: {} } as unknown as HostApiDeps);
        expect(await bare.invoke('workspaces.cloneOffers', ['acme'])).toMatchObject({ ok: false });
        expect(await bare.invoke('workspaces.applyOffer', ['acme', 'x'])).toMatchObject({ ok: false });
    });
});

describe('the service in genie-host', () => {
    const watch = (applied: string[]) => ({
        pass: async () => {},
        list: (id: string) => (id === 'acme' ? [offer] : []),
        apply: async (id: string, offerId: string) => { applied.push(`${id} ${offerId}`); return { ok: true as const }; },
    });

    it('lists a workspace’s offers with the verdict on its trust, and applies one the person asks for', async () => {
        const applied: string[] = [];
        const service = new CloneOffersService();
        service.attach({ watch: watch(applied) as never, trusted: (id) => id === 'acme' });
        expect(await service.call('list', ['acme'])).toEqual({ ok: true, offers: [offer], trusted: true });
        expect(await service.call('list', ['other'])).toEqual({ ok: true, offers: [], trusted: false });
        expect(await service.call('apply', ['acme', offer.id])).toEqual({ ok: true });
        expect(applied).toEqual(['acme flow:.flows/a.json']);
    });

    it('before the watcher is attached it says the host is still starting, and applies nothing', async () => {
        const service = new CloneOffersService();
        expect(await service.call('list', ['acme'])).toEqual({ ok: false, reason: 'the host has not started watching the repo yet; try again in a moment' });
        expect(await service.call('apply', ['acme', 'x'])).toMatchObject({ ok: false });
    });

    it('a window may call list and apply, and nothing else', async () => {
        const service = new CloneOffersService();
        service.attach({ watch: watch([]) as never, trusted: () => true });
        await expect(service.call('pass', [])).rejects.toThrow(/cannot call/);
    });
});

describe('the wiring', () => {
    it('the engine server answers engine.cloneOffers and the client asks it', () => {
        expect(src('src/main/session-engine-server.ts')).toContain("case 'engine.cloneOffers'");
        expect(src('src/main/session-engine-client.ts')).toMatch(/cloneOffers\(\)/);
    });

    it('genie-host attaches the watcher to the service and serves it to every client from its own answers', () => {
        const host = src('src/main/genie-host.ts');
        expect(host).toContain('cloneOffersService.attach(');
        expect(host).toMatch(/cloneOffers: cloneOffersService/);
        // The window's workspaces.cloneOffers is genie-host's answer now (Tynn #898 step 2d-4b2), not main asking the link.
        expect(host).toMatch(/cloneOffers: \{ cloneOffers: \(id\) => cloneOffersService\.call\('list', \[id\]\), applyOffer: \(id, offerId\) => cloneOffersService\.call\('apply', \[id, offerId\]\) \}/);
        expect(src('src/main/host-alone-api.ts')).toMatch(/workspaceLifecycleApi\([^\n]*, ports\.cloneOffers\)/);
        expect(src('src/main/main.ts')).not.toMatch(/client\.cloneOffers\(\)/);
    });

    it('the window’s bridge asks for them over the local session and the remote bridge', () => {
        expect(src('src/renderer/remote-bridge.ts')).toContain("call('workspaces.cloneOffers'");
        expect(src('src/renderer/remote-bridge.ts')).toContain("call('workspaces.applyOffer'");
        expect(src('src/renderer/local-session.ts')).toContain('cloneOffers: (id) =>');
        expect(src('src/renderer/local-session.ts')).toContain('applyOffer: (id, offerId) =>');
    });
});

describe('the list says whether the workspace is trusted by asking then, and waiting (Tynn #955)', () => {
    it('an answer that arrives later is the answer: yes for one workspace, no for another', async () => {
        const service = new CloneOffersService();
        service.attach({ watch: { pass: async () => {}, list: () => [], apply: async () => ({ ok: true as const }) } as never, trusted: (async (id: string) => id === 'acme') as never });
        expect(await service.call('list', ['acme'])).toMatchObject({ ok: true, trusted: true });
        expect(await service.call('list', ['other'])).toMatchObject({ ok: true, trusted: false });
    });
});
