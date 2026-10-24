import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { NodeInstallOutcome, NodeVersionsView } from '../src/main/node-versions.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * GENIE'S OWN NODE, from the person's clicks to what they see: Settings → Toolchain lists the Node versions Genie manages,
 * the node on PATH, and an Install per version this release offers; an Install without consent never reaches the
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

const view = (): NodeVersionsView => ({
    managed: managed.map((v) => ({ version: v, dir: `C:\\genie2-toolchain\\node-versions\\${v}` })),
    system: { version: '24.19.0' },
    available: [{ version: '24.22.1', installed: managed.includes('24.22.1') }],
});

const ports = (): FeaturePorts => ({
    toolchain: {
        probe: async () => [],
        update: async () => ({ kind: 'refused', reason: 'n/a' }),
        now: () => 5_000,
        node: {
            list: async () => view(),
            install: async (version, consent): Promise<NodeInstallOutcome> => { installs.push([version, consent]); managed = [version, ...managed]; return { kind: 'installed', version, dir: `C:\\x\\${version}` }; },
            remove: (version) => { removals.push(version); managed = managed.filter((v) => v !== version); return { kind: 'removed', version }; },
        },
    },
});
const scanned = (): FeatureState => ({ toolStatuses: [], knowledgeQuery: '', toolchainCheckedAt: 1 });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-node-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => [] });
    installs = []; removals = []; managed = [];
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('Node versions through the feature IPC', () => {
    it('a scan lists them', async () => {
        managed = ['24.22.1'];
        const snap = await handleFeatureAction(services, { kind: 'toolchain.check', force: true }, scanned(), ports());
        expect(snap.toolchain!.node).toMatchObject({ managed: [{ version: '24.22.1' }], system: { version: '24.19.0' } });
    });

    it('Install WITHOUT consent is refused on its row and never reaches the installer; with consent it installs once', async () => {
        const refused = await handleFeatureAction(services, { kind: 'toolchain.installNode', version: '24.22.1', consent: false }, scanned(), ports());
        expect(installs).toEqual([]);
        expect(refused.toolchain!.refusals).toEqual([{ tool: 'node', version: '24.22.1', reason: expect.stringMatching(/without your go-ahead/) }]);
        const snap = await handleFeatureAction(services, { kind: 'toolchain.installNode', version: '24.22.1', consent: true }, { ...scanned(), toolchainRefusals: refused.toolchain!.refusals! }, ports());
        expect(snap.toolchain!.refusals).toBeUndefined();
        expect(installs).toEqual([['24.22.1', true]]);
        expect(snap.toolchain!.node!.managed.map((m) => m.version)).toEqual(['24.22.1']);
        expect(snap.toolchain!.result).toMatch(/Node 24\.22\.1 is installed/);
    });

    it('Remove removes it and the list no longer shows it', async () => {
        managed = ['24.22.1'];
        const snap = await handleFeatureAction(services, { kind: 'toolchain.removeNode', version: '24.22.1' }, scanned(), ports());
        expect(removals).toEqual(['24.22.1']);
        expect(snap.toolchain!.node!.managed).toEqual([]);
    });
});

const render = (toolchain: FeatureData['toolchain']) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} />);
const base = { tools: [], checkedAt: 1 };

describe('Toolchain → Node versions', () => {
    it('Genie’s versions with Remove, the PATH node, and an Install per version not here', () => {
        const html = render({
            ...base,
            node: { managed: [{ version: '22.23.2', dir: 'C:\\genie2-toolchain\\node-versions\\22.23.2' }], system: { version: '24.19.0' }, available: [{ version: '24.22.1', installed: false }] },
        });
        expect(html).toContain('data-node-versions="1"');
        expect(html).toMatch(/data-node-version="22\.23\.2"[^]*?>Remove</);
        expect(html).toMatch(/node on your PATH is 24\.19\.0/);
        expect(html).toContain('data-node-install="24.22.1"');
    });

    it('macOS/Linux: the reason instead of Install buttons; no view yet: no section', () => {
        const html = render({ ...base, node: { managed: [], system: null, available: [], installRefused: 'Genie installs its own Node on Windows for now' } });
        expect(html).toContain('data-node-install-refused');
        expect(html).not.toContain('data-node-install=');
        expect(render(base)).not.toContain('data-node-versions');
    });
});
