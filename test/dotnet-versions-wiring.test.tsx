import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { DotnetInstallOutcome, DotnetVersionsView } from '../src/main/dotnet-versions.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * GENIE'S OWN .NET (TC6a), from the person's clicks to what they see: Settings → Toolchain lists the .NET SDKs Genie
 * manages, the dotnet on PATH, and an Install per version this release offers; an Install without consent never reaches the
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

const view = (): DotnetVersionsView => ({
    managed: managed.map((v) => ({ version: v, dir: `/data/genie2-toolchain/dotnet-versions/${v}` })),
    system: { version: '8.0.100' },
    available: [{ version: '10.0.402', installed: managed.includes('10.0.402') }, { version: '9.0.319', installed: managed.includes('9.0.319') }],
});

const ports = (): FeaturePorts => ({
    toolchain: {
        probe: async () => [],
        update: async () => ({ kind: 'refused', reason: 'n/a' }),
        now: () => 5_000,
        dotnet: {
            list: async () => view(),
            install: async (version, consent): Promise<DotnetInstallOutcome> => { installs.push([version, consent]); managed = [version, ...managed]; return { kind: 'installed', version, dir: `/x/${version}` }; },
            remove: async (version) => { removals.push(version); managed = managed.filter((v) => v !== version); return { kind: 'removed', version }; },
        },
    },
});
const scanned = (): FeatureState => ({ toolStatuses: [], knowledgeQuery: '', toolchainCheckedAt: 1 });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-dotnet-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => [] });
    installs = []; removals = []; managed = [];
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('.NET SDKs through the feature IPC', () => {
    it('a scan lists them', async () => {
        managed = ['10.0.402'];
        const snap = await handleFeatureAction(services, { kind: 'toolchain.check', force: true }, scanned(), ports());
        expect(snap.toolchain!.dotnet).toMatchObject({ managed: [{ version: '10.0.402' }], system: { version: '8.0.100' } });
    });

    it('Install WITHOUT consent is refused on its row and never reaches the installer; with consent it installs once', async () => {
        const refused = await handleFeatureAction(services, { kind: 'toolchain.installDotnet', version: '10.0.402', consent: false }, scanned(), ports());
        expect(installs).toEqual([]);
        expect(refused.toolchain!.refusals).toEqual([{ tool: 'dotnet', version: '10.0.402', reason: expect.stringMatching(/without your go-ahead/) }]);
        const snap = await handleFeatureAction(services, { kind: 'toolchain.installDotnet', version: '10.0.402', consent: true }, { ...scanned(), toolchainRefusals: refused.toolchain!.refusals! }, ports());
        expect(snap.toolchain!.refusals).toBeUndefined();
        expect(installs).toEqual([['10.0.402', true]]);
        expect(snap.toolchain!.dotnet!.managed.map((m) => m.version)).toEqual(['10.0.402']);
        expect(snap.toolchain!.result).toMatch(/[.]NET SDK 10\.0\.402 is installed/);
    });

    it('Remove removes it and the list no longer shows it', async () => {
        managed = ['10.0.402'];
        const snap = await handleFeatureAction(services, { kind: 'toolchain.removeDotnet', version: '10.0.402' }, scanned(), ports());
        expect(removals).toEqual(['10.0.402']);
        expect(snap.toolchain!.dotnet!.managed).toEqual([]);
    });
});

const render = (toolchain: FeatureData['toolchain']) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} />);
const base = { tools: [], checkedAt: 1 };

describe('Toolchain → .NET SDKs', () => {
    it('Genie’s versions with Remove, the PATH dotnet, and an Install per version not here', () => {
        const html = render({ ...base, dotnet: { managed: [{ version: '9.0.319', dir: '/g/9.0.319' }], system: { version: '8.0.100' }, available: [{ version: '10.0.402', installed: false }, { version: '9.0.319', installed: true }] } });
        expect(html).toContain('data-dotnet-versions="1"');
        expect(html).toMatch(/data-dotnet-version="9\.0\.319"[^]*?>Remove</);
        expect(html).toMatch(/dotnet on your PATH is 8\.0\.100/);
        expect(html).toContain('data-dotnet-install="10.0.402"');
        expect(html).not.toContain('data-dotnet-install="9.0.319"');
    });

    it('CONTROL: no .NET view yet → no section (never an empty one)', () => {
        expect(render(base)).not.toContain('data-dotnet-versions');
    });
});
