import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { JavaInstallOutcome, JavaVersionsView } from '../src/main/java-versions.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * GENIE'S OWN JAVA (TC6d, Temurin), from the person's clicks to what they see: Settings → Toolchain lists the JDKs Genie
 * manages, the java on PATH, and an Install per version this release offers; an Install without consent never reaches the
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

const view = (): JavaVersionsView => ({
    managed: managed.map((v) => ({ version: v, dir: `/data/genie2-toolchain/java-versions/${v}` })),
    system: { version: '17.0.12' },
    available: [{ version: '25.0.5+8', line: 25, installed: managed.includes('25.0.5+8') }, { version: '21.0.13+9', line: 21, installed: managed.includes('21.0.13+9') }],
});

const ports = (): FeaturePorts => ({
    toolchain: {
        probe: async () => [],
        update: async () => ({ kind: 'refused', reason: 'n/a' }),
        now: () => 5_000,
        java: {
            list: async () => view(),
            install: async (version, consent): Promise<JavaInstallOutcome> => { installs.push([version, consent]); managed = [version, ...managed]; return { kind: 'installed', version, dir: `/x/${version}` }; },
            remove: (version) => { removals.push(version); managed = managed.filter((v) => v !== version); return { kind: 'removed', version }; },
        },
    },
});
const scanned = (): FeatureState => ({ toolStatuses: [], knowledgeQuery: '', toolchainCheckedAt: 1 });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-java-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => [] });
    installs = []; removals = []; managed = [];
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('Java versions through the feature IPC', () => {
    it('a scan lists them', async () => {
        managed = ['25.0.5+8'];
        const snap = await handleFeatureAction(services, { kind: 'toolchain.check', force: true }, scanned(), ports());
        expect(snap.toolchain!.java).toMatchObject({ managed: [{ version: '25.0.5+8' }], system: { version: '17.0.12' } });
    });

    it('Install WITHOUT consent is refused on its row and never reaches the installer; with consent it installs once', async () => {
        const refused = await handleFeatureAction(services, { kind: 'toolchain.installJava', version: '25.0.5+8', consent: false }, scanned(), ports());
        expect(installs).toEqual([]);
        expect(refused.toolchain!.refusals).toEqual([{ tool: 'java', version: '25.0.5+8', reason: expect.stringMatching(/without your go-ahead/) }]);
        const snap = await handleFeatureAction(services, { kind: 'toolchain.installJava', version: '25.0.5+8', consent: true }, { ...scanned(), toolchainRefusals: refused.toolchain!.refusals! }, ports());
        expect(snap.toolchain!.refusals).toBeUndefined();
        expect(installs).toEqual([['25.0.5+8', true]]);
        expect(snap.toolchain!.java!.managed.map((m) => m.version)).toEqual(['25.0.5+8']);
        expect(snap.toolchain!.result).toMatch(/Java 25\.0\.5\+8 is installed/);
    });

    it('Remove removes it and the list no longer shows it', async () => {
        managed = ['25.0.5+8'];
        const snap = await handleFeatureAction(services, { kind: 'toolchain.removeJava', version: '25.0.5+8' }, scanned(), ports());
        expect(removals).toEqual(['25.0.5+8']);
        expect(snap.toolchain!.java!.managed).toEqual([]);
    });
});

const render = (toolchain: FeatureData['toolchain']) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} />);
const base = { tools: [], checkedAt: 1 };

describe('Toolchain → Java versions', () => {
    it('Genie’s versions with Remove, the PATH java, and an Install per version not here', () => {
        const html = render({ ...base, java: { managed: [{ version: '21.0.13+9', dir: '/g/21.0.13+9' }], system: { version: '17.0.12' }, available: [{ version: '25.0.5+8', line: 25, installed: false }, { version: '21.0.13+9', line: 21, installed: true }] } });
        expect(html).toContain('data-java-versions="1"');
        expect(html).toMatch(/data-java-version="21\.0\.13\+9"[^]*?>Remove</);
        expect(html).toMatch(/java on your PATH is 17\.0\.12/);
        expect(html).toContain('data-java-install="25.0.5+8"');
        expect(html).not.toContain('data-java-install="21.0.13+9"');
    });

    it('CONTROL: no Java view yet → no section (never an empty one)', () => {
        expect(render(base)).not.toContain('data-java-versions');
    });
});
