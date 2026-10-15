import { X509Certificate } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostsFilePath } from '../src/core/front-door-caddy.js';
import { GEN_CA_SUBJECT, TRUST_DECK_ID, trustInstallStep } from '../src/core/gen-ca.js';
import { composeServices, type ComposedServices, type FrontDoorStatus } from '../src/main/compose.js';
import type { Step } from '../src/main/elevate.js';
import { thumbprintOf, type TrustStorePort } from '../src/main/gen-ca.js';
import type { HostsIo } from '../src/main/hosts-file.js';
import type { PtyOpened, PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';
import { issueCa } from '../src/main/x509.js';

/**
 * THE EXTERNAL FRONT DOOR'S STATE — beyond "Caddy is running": whether the hosts file carries the
 * .gen block (synced on every site change, through the OS prompt only when the plain write is
 * refused, a declined prompt recorded with the block to paste), Genie's CA (its own, Genie 1's
 * adopted, or new) and whether the OS trust store holds it — READ by thumbprint, never a marker —
 * and the one Trust: one elevation, judged by the store afterwards, a failure reported with its
 * reason and never recorded as trusted. Genie asks once, on the Deck, when the store says no and a
 * site exists.
 */

function fakePty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    let n = 0;
    const port: PtyPort = {
        open(o) { const id = `term_${++n}`; opened.push({ ...o, id }); return { id, pid: 500 + n, shell: 'sh', scrollback: '' } satisfies PtyOpened; },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
    return { port, opened };
}

function fakeHosts(initial: string) {
    let content = initial;
    const state = { denyPlain: false, denyElevated: false };
    const port: HostsIo = {
        read: async () => content,
        write: async (next) => { if (state.denyPlain) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); content = next; },
        writeElevated: async (next) => { if (state.denyElevated) throw new Error('Request dismissed'); content = next; },
    };
    return { port, state, content: () => content };
}

/** The OS trust store: which thumbprints it holds, and every thumbprint it was asked about. */
function fakeStore() {
    const held = new Set<string>();
    const asked: string[] = [];
    const port: TrustStorePort = { has: async (t) => { asked.push(t); return held.has(t); } };
    return { port, held, asked };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 15));

let dir: string;
let services: ComposedServices | null = null;
let hosts: ReturnType<typeof fakeHosts>;
let store: ReturnType<typeof fakeStore>;
let elevated: Step[];
/** What the elevated install does: installs into the store, is declined, or "succeeds" without installing anything. */
let install: 'installs' | 'declined' | 'exit-0-nothing-installed' = 'installs';
let v1CaDirs: string[] = [];
const CADDY = '/opt/genie/runtime/caddy';

async function compose(caddyBin: string | null = CADDY): Promise<ComposedServices> {
    return composeServices({
        userData: dir, pty: fakePty().port, v1Settings: () => null, caddyBin, frontDoorPort: 0,
        hostsIo: hosts.port,
        trustStore: store.port,
        v1CaDirs,
        runElevated: async (step) => {
            elevated.push(step);
            if (install === 'declined') throw new Error('the user declined');
            if (install === 'installs') {
                // certutil/security/trust read the CA file the step names: what it installs is that file's thumbprint.
                const path = step.args.at(-1)!;
                store.held.add(thumbprintOf(new X509Certificate(await readFile(path))));
            }
        },
    });
}

const running = (s: ComposedServices) => s.externalFrontDoor as Extract<FrontDoorStatus, { running: true }>;
const genieItems = (s: ComposedServices) => s.deckItems().filter((i) => i.source === 'genie');
const site = (s: ComposedServices, name = 'docs') => s.sites.create({ name, workspaceId: 'tynn', repoPath: dir, serve: { mode: 'proxy' }, hostPort: 5173 });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-front-door-state-'));
    hosts = fakeHosts('127.0.0.1 localhost\n');
    store = fakeStore();
    elevated = [];
    install = 'installs';
    v1CaDirs = [];
});

afterEach(async () => {
    await services?.shutdown();
    services = null;
    await rm(dir, { recursive: true, force: true });
});

describe('the hosts file', () => {
    it('is synced at boot and on every site change; the result is on the front door state and listeners hear it', async () => {
        services = await compose();
        const heard: string[] = [];
        services.onFrontDoorChange(() => heard.push(JSON.stringify(services!.externalFrontDoor)));
        await settle();
        const caddyfile = join(dir, 'runtime', 'caddy', 'Caddyfile');
        expect(services.externalFrontDoor).toEqual({
            running: true, caddyfile, hostsPath: hostsFilePath(process.platform), hosts: { changed: true, elevated: false },
            authority: { source: 'created', thumbprint: expect.stringMatching(/^[0-9A-F]{40}$/) }, trusted: false, trustError: null, certificateError: null,
        });
        expect(hosts.content()).toContain('# >>> genie .gen sites');

        site(services);
        await settle();
        expect(hosts.content()).toContain('127.0.0.1 docs.gen');
        services.sites.remove('site_docs');
        await settle();
        expect(hosts.content()).not.toContain('docs.gen');
        expect(heard.length).toBeGreaterThanOrEqual(2);
    });

    it('a refused plain write goes through the OS prompt; a declined prompt is recorded with the block to paste, and syncHosts() tries again on request', async () => {
        hosts.state.denyPlain = true;
        services = await compose();
        await settle();
        expect(services.externalFrontDoor).toMatchObject({ hosts: { changed: true, elevated: true } });

        hosts.state.denyElevated = true;
        site(services);
        await settle();
        const fd = services.externalFrontDoor as { hosts: { error: string; manualBlock: string } };
        expect(fd.hosts.error).toBe('Request dismissed');
        expect(fd.hosts.manualBlock).toContain('127.0.0.1 docs.gen');

        hosts.state.denyElevated = false;
        expect(await services.syncHosts()).toEqual({ changed: true, elevated: true });
        expect(hosts.content()).toContain('127.0.0.1 docs.gen');
    });

    it('without a bundled Caddy nothing is synced and syncHosts says why', async () => {
        services = await compose(null);
        await settle();
        expect(hosts.content()).toBe('127.0.0.1 localhost\n');
        expect(services.externalFrontDoor).toEqual({ running: false, reason: 'this install has no bundled Caddy; https://<name>.gen in external browsers is off, the in-app browser still works' });
        await expect(services.syncHosts()).rejects.toThrow(/no bundled Caddy/);
    });
});

describe('the Caddyfile serves Genie’s leaf', () => {
    it('every route is served with tls <leaf.crt> <leaf.key> under runtime/gen-ca — never tls internal — and the leaf names every route', async () => {
        services = await compose();
        site(services, 'docs');
        site(services, 'tynn');
        const caddyfile = (await readFile(join(dir, 'runtime', 'caddy', 'Caddyfile'))).toString();
        const ca = join(dir, 'runtime', 'gen-ca').replace(/\\/g, '/');
        expect(caddyfile).not.toMatch(/tls\s+internal/);
        expect(caddyfile.match(/^\ttls /gm) ?? []).toHaveLength(2);
        expect(caddyfile).toContain(`https://docs.gen {\n\ttls "${ca}/leaf.crt" "${ca}/leaf.key"\n`);
        expect(caddyfile).toContain(`https://tynn.gen {\n\ttls "${ca}/leaf.crt" "${ca}/leaf.key"\n`);
        const leaf = new X509Certificate(await readFile(join(dir, 'runtime', 'gen-ca', 'leaf.crt')));
        expect(leaf.subjectAltName).toBe('DNS:docs.gen, DNS:tynn.gen');
        expect(leaf.verify(new X509Certificate(await readFile(join(dir, 'runtime', 'gen-ca', 'ca.crt'))).publicKey)).toBe(true);
    });
});

describe('trust is READ from the OS store by the CA’s thumbprint', () => {
    it('upgrade path: Genie 1’s CA, already in the store, is adopted — trusted at boot, no Deck item, no prompt (positive control)', async () => {
        const v1 = join(dir, 'genie1-userData', 'host-gen');
        mkdirSync(v1, { recursive: true });
        const g1 = issueCa({ ...GEN_CA_SUBJECT, notBefore: new Date(Date.now() - 86_400_000), notAfter: new Date(Date.now() + 3000 * 86_400_000) });
        writeFileSync(join(v1, 'gen-ca.crt'), g1.certPem);
        writeFileSync(join(v1, 'gen-ca.key'), g1.keyPem);
        const thumb = thumbprintOf(new X509Certificate(g1.certPem));
        store.held.add(thumb);
        v1CaDirs = [v1];

        services = await compose();
        site(services);
        await settle();
        expect(running(services)).toMatchObject({ authority: { source: 'adopted-v1', thumbprint: thumb }, trusted: true, trustError: null });
        expect(store.asked).toEqual([thumb]);
        expect(genieItems(services)).toEqual([]);
        expect(elevated).toEqual([]);
    });

    it('a store holding only OTHER certificates reads untrusted (negative control) — asked about this CA’s thumbprint and nothing else', async () => {
        store.held.add('F'.repeat(40));
        services = await compose();
        await settle();
        const fd = running(services);
        expect(fd.trusted).toBe(false);
        expect(store.asked).toEqual([fd.authority.thumbprint]);
    });

    it('until the store has answered, trust is unknown (null) — no Deck item and no Trust line yet', async () => {
        let answer!: (v: boolean) => void;
        store.port.has = () => new Promise<boolean>((r) => { answer = r; });
        services = await compose();
        site(services);
        expect(running(services).trusted).toBeNull();
        expect(genieItems(services)).toEqual([]);
        answer(false);
        await settle();
        expect(running(services).trusted).toBe(false);
        expect(genieItems(services).map((i) => i.id)).toEqual([TRUST_DECK_ID]);
    });

    it('a store that cannot be read is untrusted WITH the reason, so the Trust door stays', async () => {
        store.port.has = async () => { throw new Error('the Windows certificate store answered "", not True or False'); };
        services = await compose();
        await settle();
        expect(running(services)).toMatchObject({ trusted: false, trustError: 'Genie could not read the trust store: the Windows certificate store answered "", not True or False' });
    });

    it('the marker earlier betas left (runtime/caddy/trusted) is not trust: it is removed and the store decides', async () => {
        mkdirSync(join(dir, 'runtime', 'caddy'), { recursive: true });
        writeFileSync(join(dir, 'runtime', 'caddy', 'trusted'), '2026-10-13T00:00:00.000Z');
        services = await compose();
        await settle();
        expect(running(services).trusted).toBe(false);
        await expect(stat(join(dir, 'runtime', 'caddy', 'trusted'))).rejects.toThrow();
    });
});

describe('Trust: one elevation, judged by the store', () => {
    it('installs Genie’s CA (its ca.crt) through ONE OS prompt; the store, read again, holds it → trusted; a restart reads it trusted with no second prompt and no marker', async () => {
        services = await compose();
        await settle();
        expect(running(services).trusted).toBe(false);
        expect(await services.trustCertificate()).toEqual({ ok: true });
        expect(elevated).toEqual([trustInstallStep(process.platform, join(dir, 'runtime', 'gen-ca', 'ca.crt'))]);
        expect(running(services)).toMatchObject({ trusted: true, trustError: null });

        await services.shutdown();
        services = await compose();
        await settle();
        expect(running(services).trusted).toBe(true);
        expect(await services.trustCertificate()).toEqual({ ok: true });
        expect(elevated).toHaveLength(1);
        await expect(stat(join(dir, 'runtime', 'caddy', 'trusted'))).rejects.toThrow();
    });

    it('a declined or FAILED elevated step is reported with its reason and nothing is trusted — not now, not after a restart', async () => {
        install = 'declined';
        services = await compose();
        await settle();
        const r = await services.trustCertificate();
        expect(r).toEqual({ ok: false, reason: 'Genie could not install its certificate into the trust store: the user declined' });
        expect(running(services)).toMatchObject({ trusted: false, trustError: 'Genie could not install its certificate into the trust store: the user declined' });
        expect(store.held.size).toBe(0);

        await services.shutdown();
        services = await compose();
        await settle();
        expect(running(services).trusted).toBe(false);

        // Positive control: the same Trust, the install succeeding, is trusted.
        install = 'installs';
        expect(await services.trustCertificate()).toEqual({ ok: true });
        expect(running(services)).toMatchObject({ trusted: true, trustError: null });
    });

    it('an install that exits 0 but leaves the store without the CA is NOT trusted — the store is the judge, not the exit code', async () => {
        install = 'exit-0-nothing-installed';
        services = await compose();
        await settle();
        const thumb = running(services).authority.thumbprint;
        expect(await services.trustCertificate()).toEqual({ ok: false, reason: `the install finished, but the trust store does not hold Genie’s certificate (thumbprint ${thumb})` });
        expect(running(services).trusted).toBe(false);
        expect(elevated).toHaveLength(1);
    });

    it('two Trusts pressed together (the Deck and Hosting) raise ONE prompt', async () => {
        services = await compose();
        await settle();
        const [a, b] = await Promise.all([services.trustCertificate(), services.trustCertificate()]);
        expect([a, b]).toEqual([{ ok: true }, { ok: true }]);
        expect(elevated).toHaveLength(1);
    });

    it('with no bundled Caddy the answer says why', async () => {
        services = await compose(null);
        expect(await services.trustCertificate()).toEqual({ ok: false, reason: 'this install has no bundled Caddy; https://<name>.gen in external browsers is off, the in-app browser still works' });
        expect(elevated).toEqual([]);
    });
});

describe('Genie asks once, on the Deck', () => {
    it('appears only when the store said untrusted AND a site exists; gone once trusted', async () => {
        services = await compose();
        await settle();
        expect(running(services).trusted).toBe(false);
        expect(genieItems(services)).toEqual([]);
        site(services);
        await settle();
        const items = genieItems(services);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ id: TRUST_DECK_ID, title: 'Trust Genie’s certificate so https://docs.gen works in your browser', agentId: null });
        expect(await services.trustCertificate()).toEqual({ ok: true });
        expect(genieItems(services)).toEqual([]);
    });

    it('Not now: gone, and not asked again for this CA after a restart — Hosting’s Trust still works', async () => {
        services = await compose();
        site(services);
        await settle();
        expect(genieItems(services)).toHaveLength(1);
        services.deferTrustCertificate();
        expect(genieItems(services)).toEqual([]);

        await services.shutdown();
        services = await compose();
        site(services, 'tynn');
        await settle();
        expect(services.sites.list().length).toBeGreaterThan(0);
        expect(running(services).trusted).toBe(false);
        expect(genieItems(services)).toEqual([]);
        expect(await services.trustCertificate()).toEqual({ ok: true });
    });
});
