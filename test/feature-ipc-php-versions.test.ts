import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { PhpInstallOutcome, PhpVersionsView, SitePin } from '../src/main/php-versions.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * T4 THROUGH THE FEATURE IPC — the person's clicks on PHP versions. The ports are fakes that COUNT: an install without
 * consent never reaches the installer; a removal is checked against the PINS of the sites Genie actually knows; the Add
 * a site form is offered the versions Genie manages.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};

let dir: string;
let services: ComposedServices;
let installs: Array<[string, boolean]>;
let removals: Array<[string, readonly SitePin[]]>;
let managed: string[];

const view = (pins: readonly SitePin[]): PhpVersionsView => ({
    managed: managed.map((v) => ({ version: v, dir: `C:\\genie2-toolchain\\php-versions\\${v}`, usedBy: pins.filter((p) => v.startsWith(p.pin)).map((p) => p.host) })),
    system: { version: '8.4.13' },
    available: [{ version: '8.5.11', installed: managed.includes('8.5.11') }, { version: '8.4.26', installed: managed.includes('8.4.26') }],
});

const ports = (): FeaturePorts => ({
    toolchain: {
        probe: async () => [],
        update: async () => ({ kind: 'refused', reason: 'n/a' }),
        now: () => 5_000,
        php: {
            list: async (pins) => view(pins),
            install: async (version, consent): Promise<PhpInstallOutcome> => { installs.push([version, consent]); managed = [version, ...managed]; return { kind: 'installed', version, dir: `C:\\x\\${version}` }; },
            remove: (version, pins) => {
                removals.push([version, pins]);
                const by = pins.filter((p) => version.startsWith(p.pin)).map((p) => p.host);
                if (by.length > 0) return { kind: 'refused', reason: `PHP ${version} is pinned by ${by.join(', ')}` };
                managed = managed.filter((v) => v !== version);
                return { kind: 'removed', version };
            },
        },
    },
});
const scanned = (): FeatureState => ({ toolStatuses: [], knowledgeQuery: '', toolchainCheckedAt: 1 });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-php-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => [] });
    installs = []; removals = []; managed = ['8.4.26'];
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('T4 — PHP versions from the Toolchain surface', () => {
    it('a scan lists them: Genie’s versions, the PATH PHP, what can be installed', async () => {
        const snap = await handleFeatureAction(services, { kind: 'toolchain.check', force: true }, scanned(), ports());
        expect(snap.toolchain!.php).toMatchObject({ managed: [{ version: '8.4.26', usedBy: [] }], system: { version: '8.4.13' } });
    });

    it('Install WITHOUT consent is refused and the installer is never called; with consent it installs once and the list shows it', async () => {
        await expect(handleFeatureAction(services, { kind: 'toolchain.installPhp', version: '8.5.11', consent: false }, scanned(), ports())).rejects.toThrow(/without your go-ahead/);
        expect(installs).toEqual([]);
        const snap = await handleFeatureAction(services, { kind: 'toolchain.installPhp', version: '8.5.11', consent: true }, scanned(), ports());
        expect(installs).toEqual([['8.5.11', true]]);
        expect(snap.toolchain!.php!.managed.map((m) => m.version)).toEqual(['8.5.11', '8.4.26']);
        expect(snap.toolchain!.result).toMatch(/PHP 8\.5\.11 is installed/);
    });

    it('Remove is checked against the pins of the sites Genie knows: refused while one is pinned, named', async () => {
        services.sites.declare({ name: 'shop', workspaceId: 'acme', repoPath: dir, serve: { mode: 'php', root: 'public', version: '8.4' } });
        services.sites.declare({ name: 'blog', workspaceId: 'acme', repoPath: dir, serve: { mode: 'php', root: 'public' } });
        await expect(handleFeatureAction(services, { kind: 'toolchain.removePhp', version: '8.4.26' }, scanned(), ports())).rejects.toThrow(/pinned by shop\.gen/);
        expect(removals).toEqual([['8.4.26', [{ host: 'shop.gen', pin: '8.4' }]]]);
        expect(managed).toEqual(['8.4.26']);
    });

    it('control: with no site pinned to it, Remove removes it and the list no longer shows it', async () => {
        services.sites.declare({ name: 'blog', workspaceId: 'acme', repoPath: dir, serve: { mode: 'php', root: 'public' } });
        const snap = await handleFeatureAction(services, { kind: 'toolchain.removePhp', version: '8.4.26' }, scanned(), ports());
        expect(removals).toEqual([['8.4.26', []]]);
        expect(snap.toolchain!.php!.managed).toEqual([]);
    });

    it('Add a site offers the versions Genie manages as the PHP version choices', async () => {
        const snap = await handleFeatureAction(services, { kind: 'hosting.addSite', workspaceId: 'acme', repoPath: dir }, scanned(), ports());
        expect(snap.hosting!.adding!.phpVersions).toEqual(['8.4.26']);
    });
});
