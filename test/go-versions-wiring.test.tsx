import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { GoInstallOutcome, GoVersionsView } from '../src/main/go-versions.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * GENIE'S OWN GO, from the person's clicks to what they see: Settings → Toolchain lists the Go versions Genie manages,
 * the go on PATH, and an Install per version this release offers; an Install without consent never reaches the
 * installer; Remove removes. The ports are fakes that count.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};

let dir: string;
let services: ComposedServices;
let installs: Array<[string, boolean]>;
let removals: string[];
let managed: string[];

const view = (): GoVersionsView => ({
    managed: managed.map((v) => ({ version: v, dir: `/data/genie2-toolchain/go-versions/${v}` })),
    system: { version: '1.22.2' },
    available: [{ version: '1.27.3', installed: managed.includes('1.27.3') }, { version: '1.26.10', installed: managed.includes('1.26.10') }],
});

const ports = (): FeaturePorts => ({
    toolchain: {
        probe: async () => [],
        update: async () => ({ kind: 'refused', reason: 'n/a' }),
        now: () => 5_000,
        go: {
            list: async () => view(),
            install: async (version, consent): Promise<GoInstallOutcome> => { installs.push([version, consent]); managed = [version, ...managed]; return { kind: 'installed', version, dir: `/x/${version}` }; },
            remove: (version) => { removals.push(version); managed = managed.filter((v) => v !== version); return { kind: 'removed', version }; },
        },
    },
});
const scanned = (): FeatureState => ({ toolStatuses: [], knowledgeQuery: '', toolchainCheckedAt: 1 });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-go-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => [] });
    installs = []; removals = []; managed = [];
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('Go versions through the feature IPC', () => {
    it('a scan lists them', async () => {
        managed = ['1.27.3'];
        const snap = await handleFeatureAction(services, { kind: 'toolchain.check', force: true }, scanned(), ports());
        expect(snap.toolchain!.go).toMatchObject({ managed: [{ version: '1.27.3' }], system: { version: '1.22.2' } });
    });

    it('Install WITHOUT consent is refused on its row and never reaches the installer; with consent it installs once', async () => {
        const refused = await handleFeatureAction(services, { kind: 'toolchain.installGo', version: '1.27.3', consent: false }, scanned(), ports());
        expect(installs).toEqual([]);
        expect(refused.toolchain!.refusals).toEqual([{ tool: 'go', version: '1.27.3', reason: expect.stringMatching(/without your go-ahead/) }]);
        const snap = await handleFeatureAction(services, { kind: 'toolchain.installGo', version: '1.27.3', consent: true }, { ...scanned(), toolchainRefusals: refused.toolchain!.refusals! }, ports());
        expect(snap.toolchain!.refusals).toBeUndefined();
        expect(installs).toEqual([['1.27.3', true]]);
        expect(snap.toolchain!.go!.managed.map((m) => m.version)).toEqual(['1.27.3']);
        expect(snap.toolchain!.result).toMatch(/Go 1\.27\.3 is installed/);
    });

    it('Remove removes it and the list no longer shows it', async () => {
        managed = ['1.27.3'];
        const snap = await handleFeatureAction(services, { kind: 'toolchain.removeGo', version: '1.27.3' }, scanned(), ports());
        expect(removals).toEqual(['1.27.3']);
        expect(snap.toolchain!.go!.managed).toEqual([]);
    });
});

const render = (toolchain: FeatureData['toolchain']) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} />);
const base = { tools: [], checkedAt: 1 };

describe('Toolchain → Go versions', () => {
    it('Genie’s versions with Remove, the PATH go, and an Install per version not here', () => {
        const html = render({ ...base, go: { managed: [{ version: '1.26.10', dir: '/g/1.26.10' }], system: { version: '1.22.2' }, available: [{ version: '1.27.3', installed: false }, { version: '1.26.10', installed: true }] } });
        expect(html).toContain('data-go-versions="1"');
        expect(html).toMatch(/data-go-version="1\.26\.10"[^]*?>Remove</);
        expect(html).toMatch(/go on your PATH is 1\.22\.2/);
        expect(html).toContain('data-go-install="1.27.3"');
        expect(html).not.toContain('data-go-install="1.26.10"');
    });

    it('CONTROL: no Go view yet → no section (never an empty one)', () => {
        expect(render(base)).not.toContain('data-go-versions');
    });
});
