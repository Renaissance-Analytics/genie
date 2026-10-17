import { X509Certificate } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostsFilePath } from '../src/core/front-door-caddy.js';
import { GEN_CA_SUBJECT, TRUST_DECK_ID, trustInstallStep } from '../src/core/gen-ca.js';
import { hostsFileBlock } from '../src/core/gen-router.js';
import type { ComposedServices, FrontDoorStatus } from '../src/main/compose.js';
import type { ElevationOutcome, PrivilegedStep, Step } from '../src/main/elevate.js';
import type { FrontDoorPort, FrontDoorPorts, PortProbe } from '../src/main/front-door-port.js';
import { thumbprintOf, x509Issuer, type CertIssuer, type TrustStorePort } from '../src/main/gen-ca.js';
import type { HostsIo } from '../src/main/hosts-file.js';
import type { PtyOpened, PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';
import { issueCa, type IssuedPem } from '../src/main/x509.js';
import { composeTracker } from './support/compose-tracker.js';

/**
 * THE EXTERNAL FRONT DOOR'S STATE — beyond "Caddy is running": whether the hosts file carries the
 * .gen block — the CONFIGURED names, so a site's start or stop never writes it (S4); one write per
 * burst; through the OS prompt only when the plain write is refused, a declined prompt recorded with
 * the block to paste — Genie's CA (its own, Genie 1's adopted, or new) and whether the OS trust store
 * holds it — READ by thumbprint, never a marker — and the one Trust: one elevation (carrying a due
 * hosts write), judged by the store afterwards, a failure reported with its reason and never recorded
 * as trusted. Genie asks once, on the Deck, when the store says no and a site exists. And the ports:
 * a :443 another process holds is reported by name, with Caddy neither started nor restarted (S8).
 */

function fakePty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    const dataListeners = new Set<(id: string, data: string) => void>();
    const exitListeners = new Set<(id: string, code: number) => void>();
    let n = 0;
    const port: PtyPort = {
        open(o) { const id = `term_${++n}`; opened.push({ ...o, id }); return { id, pid: 500 + n, shell: 'sh', scrollback: '' } satisfies PtyOpened; },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
        onData: (l) => { dataListeners.add(l); return () => { dataListeners.delete(l); }; },
        onExit: (l) => { exitListeners.add(l); return () => { exitListeners.delete(l); }; },
    };
    return {
        port,
        opened,
        caddy: () => opened.filter((o) => o.command?.includes(' run --config ') && o.command.includes('--watch')),
        emit: (id: string, data: string) => { for (const l of dataListeners) l(id, data); },
        exit: (id: string, code: number) => { for (const l of exitListeners) l(id, code); },
    };
}

function fakeHosts(initial: string) {
    let content = initial;
    let staged: string | null = null;
    const state = { denyPlain: false, denyElevated: false };
    const counts = { reads: 0, plainWrites: 0, elevatedWrites: 0 };
    const port: HostsIo = {
        read: async () => { counts.reads += 1; return content; },
        write: async (next) => { if (state.denyPlain) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); counts.plainWrites += 1; content = next; },
        stage: async (next) => { staged = next; return { command: 'cp', args: ['/home/user/.genie/runtime/hosts.next', hostsFilePath(process.platform)] }; },
    };
    return { port, state, counts, content: () => content, writes: () => counts.plainWrites + counts.elevatedWrites, apply: () => { if (staged !== null) { content = staged; counts.elevatedWrites += 1; } } };
}

/** The OS trust store: which thumbprints it holds, and every thumbprint it was asked about. */
function fakeStore() {
    const held = new Set<string>();
    const asked: string[] = [];
    const port: TrustStorePort = { has: async (t) => { asked.push(t); return held.has(t); } };
    return { port, held, asked };
}

/** :443 and :80 as the OS would answer: free unless a test says who holds one. */
function fakePorts() {
    const probes: Partial<Record<FrontDoorPort, PortProbe>> = {};
    const holders: Partial<Record<FrontDoorPort, string>> = {};
    const port: FrontDoorPorts = { probe: async (p) => probes[p] ?? 'free', holder: async (p) => holders[p] ?? null };
    return { port, probes, holders };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 40));

let dir: string;
let services: ComposedServices | null = null;
/** Every composition a test starts is shut down before its folder is removed — one still composing when a test timed out included (B13). */
const composed = composeTracker();
let pty: ReturnType<typeof fakePty>;
let hosts: ReturnType<typeof fakeHosts>;
let store: ReturnType<typeof fakeStore>;
let ports: ReturnType<typeof fakePorts>;
/** Every step that went through an elevation, and each elevation's batch (by step id) — one batch is one OS prompt. */
let elevated: Step[];
let batches: string[][];
/** What the elevated trust install does: installs into the store, is declined, fails (its own words), or "succeeds" without installing anything. */
let install: 'installs' | 'declined' | 'fails' | 'exit-0-nothing-installed' = 'installs';
let v1CaDirs: string[] = [];
const CADDY = '/opt/genie/runtime/caddy';

async function elevate(steps: readonly PrivilegedStep[]): Promise<ElevationOutcome> {
    batches.push(steps.map((s) => s.id));
    elevated.push(...steps.map((s) => s.step));
    if (install === 'declined' && steps.some((s) => s.id === 'trust')) return { ok: false, failed: null, error: 'the user declined' };
    if (hosts.state.denyElevated) return { ok: false, failed: null, error: 'Request dismissed' };
    for (const s of steps) {
        if (s.id === 'trust') {
            if (install === 'fails') return { ok: false, failed: { id: s.id, label: s.label }, error: 'CertAddCertificateContextToStore failed' };
            // certutil/security/trust read the CA file the step names: what it installs is that file's thumbprint.
            if (install === 'installs') store.held.add(thumbprintOf(new X509Certificate(await readFile(s.step.args.at(-1)!))));
        }
        if (s.id === 'hosts') hosts.apply();
    }
    return { ok: true };
}

/**
 * The REAL issuer, its certificates made once per file. Every compose here opened a fresh CA and leaf, each a
 * synchronous RSA-2048 key generation, whose time is a random prime search: on the GitHub Windows runner one S4 test
 * spent its whole 5 s in it (the beta.29 release build, 2026-10-17). What these tests count is hosts writes, prompts
 * and trust; the certificates are still real and still the CA's, only not minted again for each test.
 */
const madeCa = new Map<string, IssuedPem>();
const madeLeaf = new Map<string, IssuedPem>();
const onceIssuer: CertIssuer = {
    ca: (now) => { let c = madeCa.get('ca'); if (!c) { c = x509Issuer.ca(now); madeCa.set('ca', c); } return c; },
    leaf: (ca, hosts, now) => {
        const key = `${ca.certPem}|${[...hosts].sort().join(',')}`;
        let l = madeLeaf.get(key);
        if (!l) { l = x509Issuer.leaf(ca, hosts, now); madeLeaf.set(key, l); }
        return l;
    },
};

async function compose(caddyBin: string | null = CADDY): Promise<ComposedServices> {
    return composed.compose({
        userData: dir, pty: pty.port, v1Settings: () => null, caddyBin, frontDoorPort: 0,
        hostsIo: hosts.port,
        trustStore: store.port,
        v1CaDirs,
        elevate,
        hostsDebounceMs: 5,
        frontDoorPorts: ports.port,
        certIssuer: onceIssuer,
    });
}

const running = (s: ComposedServices) => s.externalFrontDoor as Extract<FrontDoorStatus, { running: true }>;
const genieItems = (s: ComposedServices) => s.deckItems().filter((i) => i.source === 'genie');
const site = (s: ComposedServices, name = 'docs') => s.sites.create({ name, workspaceId: 'tynn', repoPath: dir, serve: { mode: 'proxy' }, hostPort: 5173 });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-front-door-state-'));
    pty = fakePty();
    hosts = fakeHosts('127.0.0.1 localhost\n');
    store = fakeStore();
    ports = fakePorts();
    elevated = [];
    batches = [];
    install = 'installs';
    v1CaDirs = [];
});

afterEach(async () => {
    await composed.shutdownAll();
    services = null;
    await rm(dir, { recursive: true, force: true });
});

describe('the hosts file', () => {
    it('follows the configured sites: nothing to write at a boot with none; a site added is written (both loopbacks), a site removed is taken out; listeners hear it', async () => {
        services = await compose();
        const heard: string[] = [];
        services.onFrontDoorChange(() => heard.push(JSON.stringify(services!.externalFrontDoor)));
        await settle();
        const caddyfile = join(dir, 'runtime', 'caddy', 'Caddyfile');
        expect(services.externalFrontDoor).toEqual({
            running: true, caddyfile, hostsPath: hostsFilePath(process.platform), hosts: { changed: false, elevated: false },
            authority: { source: 'created', thumbprint: expect.stringMatching(/^[0-9A-F]{40}$/) }, trusted: false, trustError: null, certificateError: null,
        });
        expect(hosts.content()).toBe('127.0.0.1 localhost\n');
        expect(hosts.writes()).toBe(0);

        site(services);
        await settle();
        expect(hosts.content()).toContain('127.0.0.1 docs.gen');
        expect(hosts.content()).toContain('::1 docs.gen');
        services.sites.remove('site_docs');
        await settle();
        expect(hosts.content()).not.toContain('docs.gen');
        expect(heard.length).toBeGreaterThanOrEqual(2);
    });

    it('a refused plain write goes through the OS prompt; a declined prompt is recorded with the block to paste, and syncHosts() tries again on request', async () => {
        hosts.state.denyPlain = true;
        services = await compose();
        site(services, 'tynn');
        await settle();
        expect(services.externalFrontDoor).toMatchObject({ hosts: { changed: true, elevated: true } });
        expect(batches).toEqual([['hosts']]);

        hosts.state.denyElevated = true;
        site(services);
        await settle();
        const fd = services.externalFrontDoor as { hosts: { error: string; manualBlock: string } };
        expect(fd.hosts.error).toBe('Request dismissed');
        expect(fd.hosts.manualBlock).toBe(hostsFileBlock(['docs.gen', 'tynn.gen']));

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

describe('no admin prompt on a site’s start or stop (S4)', () => {
    it('starting and stopping sites with an UNCHANGED configured set writes the hosts file ZERO times (counted); adding a site is ONE write', async () => {
        services = await compose();
        site(services, 'docs');
        site(services, 'tynn');
        await settle();
        expect(hosts.writes()).toBe(1);
        const reads = hosts.counts.reads;

        for (let i = 0; i < 4; i++) {
            services.sites.stop('site_docs');
            services.sites.start('site_docs');
            await settle();
            services.sites.stop('site_tynn');
            await settle();
            services.sites.start('site_tynn');
        }
        await settle();
        expect(services.routes().map((r) => r.host).sort()).toEqual(['docs.gen', 'tynn.gen']);
        expect(hosts.writes()).toBe(1);
        // Not even read: a start/stop never reaches the file.
        expect(hosts.counts.reads).toBe(reads);
        // A stopped site still resolves — its name is configured.
        services.sites.stop('site_docs');
        await settle();
        expect(hosts.content()).toContain('127.0.0.1 docs.gen');

        // Positive control in the same run: a NEW site is exactly one write.
        site(services, 'shop');
        await settle();
        expect(hosts.writes()).toBe(2);
        expect(hosts.content()).toContain('::1 shop.gen');
    });

    it('the same holds through the OS prompt: start/stop raise NO elevation; one new site raises one', async () => {
        hosts.state.denyPlain = true;
        services = await compose();
        site(services, 'docs');
        await settle();
        expect(batches).toEqual([['hosts']]);
        for (let i = 0; i < 3; i++) { services.sites.stop('site_docs'); await settle(); services.sites.start('site_docs'); await settle(); }
        expect(batches).toEqual([['hosts']]);
        site(services, 'tynn');
        await settle();
        expect(batches).toEqual([['hosts'], ['hosts']]);
    });

    it('a burst of N site changes is ONE write — never a prompt per site', async () => {
        hosts.state.denyPlain = true;
        services = await compose();
        await settle();
        for (const name of ['a', 'b', 'c', 'd', 'e']) site(services, name);
        await settle();
        expect(hosts.writes()).toBe(1);
        expect(batches).toEqual([['hosts']]);
        for (const name of ['a', 'b', 'c', 'd', 'e']) expect(hosts.content()).toContain(`127.0.0.1 ${name}.gen`);
    });

    it('trust and a hosts write due together → exactly ONE elevation carrying both steps', async () => {
        hosts.state.denyPlain = true;
        services = await compose();
        await settle();
        site(services);
        // The hosts write is due (its debounce pending) when the person presses Trust.
        expect(await services.trustCertificate()).toEqual({ ok: true });
        await settle();
        expect(batches).toEqual([['trust', 'hosts']]);
        expect(elevated[0]).toEqual(trustInstallStep(process.platform, join(dir, 'runtime', 'gen-ca', 'ca.crt')));
        expect(running(services)).toMatchObject({ trusted: true, trustError: null, hosts: { changed: true, elevated: true } });
        expect(hosts.content()).toContain('127.0.0.1 docs.gen');
    });

    it('a failed step in that one prompt is reported BY NAME, and the step it stopped is reported as not done', async () => {
        hosts.state.denyPlain = true;
        install = 'fails';
        services = await compose();
        await settle();
        site(services);
        const r = await services.trustCertificate();
        expect(r).toEqual({ ok: false, reason: 'Genie could not install its certificate into the trust store: CertAddCertificateContextToStore failed' });
        expect(batches).toEqual([['trust', 'hosts']]);
        expect(running(services).hosts).toEqual({
            changed: false, elevated: false,
            error: 'not done: install Genie’s certificate into the trust store failed first in the same prompt (CertAddCertificateContextToStore failed)',
            manualBlock: hostsFileBlock(['docs.gen']),
        });
    });

    it('Genie 1’s block is removed ONCE — by the same write that adds Genie 2’s block with ::1 lines — and a restart writes nothing', async () => {
        hosts = fakeHosts('127.0.0.1 localhost\n# BEGIN GENIE SITES\n127.0.0.1\tdocs.gen\n::1\tdocs.gen\n127.0.0.1\told.gen\n::1\told.gen\n# END GENIE SITES\n');
        services = await compose();
        site(services);
        await settle();
        expect(hosts.writes()).toBe(1);
        expect(hosts.content()).toBe(`127.0.0.1 localhost\n${hostsFileBlock(['docs.gen'])}\n`);
        expect(hosts.content()).toContain('::1 docs.gen');

        await services.shutdown();
        services = await compose();
        site(services);
        await settle();
        expect(hosts.writes()).toBe(1);
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

describe('the front door’s ports (S8)', () => {
    const CADDY_SAYS_HELD = 'Error: loading initial config: loading new config: http app module: start: listening on 127.0.0.1:443: listen tcp 127.0.0.1:443: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted.\r\n';

    it(':443 held by another process → Hosting says so, by name; Caddy is never started (counted), so there is nothing to restart', async () => {
        ports.probes[443] = 'held';
        ports.holders[443] = 'nginx';
        services = await compose();
        await settle();
        expect(services.externalFrontDoor).toEqual({
            running: false,
            reason: 'another process holds :443 (nginx); https://<name>.gen in external browsers is off until it lets go — the in-app browser still works',
            blocked: { port: 443, holder: 'nginx' },
        });
        expect(pty.caddy()).toHaveLength(0);
        expect(services.supervisor.status('genie-front-door')).toBeNull();
    });

    it('control: with :443 and :80 free, Caddy runs — once — and the front door is running', async () => {
        services = await compose();
        await settle();
        expect(pty.caddy()).toHaveLength(1);
        expect(services.externalFrontDoor.running).toBe(true);
    });

    it('a privileged port the OS will not let Genie itself bind (Linux, `denied`) is not "held": Caddy may still bind it, so it is started', async () => {
        ports.probes[443] = 'denied';
        ports.probes[80] = 'denied';
        services = await compose();
        await settle();
        expect(pty.caddy()).toHaveLength(1);
        expect(services.externalFrontDoor.running).toBe(true);
    });

    it('Caddy’s own words: a bind on :443 that fails while running (taken after the probe) stops the front door instead of a restart loop, and names the holder', async () => {
        services = await compose();
        await settle();
        const [caddy] = pty.caddy();
        expect(caddy).toBeDefined();
        ports.holders[443] = 'httpd';
        pty.emit(caddy!.id, CADDY_SAYS_HELD);
        pty.exit(caddy!.id, 1);
        await settle();
        expect(services.externalFrontDoor).toEqual({
            running: false,
            reason: 'another process holds :443 (httpd); https://<name>.gen in external browsers is off until it lets go — the in-app browser still works',
            blocked: { port: 443, holder: 'httpd' },
        });
        // Stopped, not `restarting`: the `always` policy does not bring it back into the same wall.
        expect(services.supervisor.status('genie-front-door')?.state).toBe('stopped');
        expect(pty.caddy()).toHaveLength(1);
    });

    it('Try again, once the port is free, starts the front door; while still held it stays off with the reason', async () => {
        ports.probes[443] = 'held';
        services = await compose();
        await settle();
        expect(await services.retryFrontDoor()).toMatchObject({ running: false, blocked: { port: 443, holder: null } });
        expect(pty.caddy()).toHaveLength(0);
        ports.probes[443] = 'free';
        expect(await services.retryFrontDoor()).toMatchObject({ running: true });
        expect(pty.caddy()).toHaveLength(1);
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
        expect(batches).toEqual([['trust']]);
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
        expect(batches).toHaveLength(1);
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
