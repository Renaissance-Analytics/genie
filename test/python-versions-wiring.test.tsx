import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { PythonInstallOutcome, PythonVersionsView } from '../src/main/python-versions.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * GENIE'S OWN PYTHON (TC4a), from the person's clicks to what they see: Settings → Toolchain lists the Python versions
 * Genie manages, the python on PATH, and an Install per version this release offers — or, where Genie cannot install
 * one yet (macOS, Linux), says why instead of offering buttons; an Install without consent never reaches the
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
let pyDefault: string | null;

const view = (): PythonVersionsView => ({
    managed: managed.map((v) => ({ version: v, dir: `/data/genie2-toolchain/python-versions/${v}` })),
    system: { version: '3.12.4' },
    available: [{ version: '3.15.1', installed: managed.includes('3.15.1') }, { version: '3.14.9', installed: managed.includes('3.14.9') }],
});

const ports = (): FeaturePorts => ({
    toolchain: {
        probe: async () => [],
        update: async () => ({ kind: 'refused', reason: 'n/a' }),
        now: () => 5_000,
        python: {
            list: async () => view(),
            install: async (version, consent): Promise<PythonInstallOutcome> => { installs.push([version, consent]); managed = [version, ...managed]; return { kind: 'installed', version, dir: `/x/${version}` }; },
            remove: (version) => { removals.push(version); managed = managed.filter((v) => v !== version); return { kind: 'removed', version }; },
        },
        defaults: {
            list: () => ({ node: null, go: null, php: null, python: pyDefault, dotnet: null, rust: null }),
            set: (lang, version) => { if (lang === 'python') pyDefault = version; return version === null ? { kind: 'cleared', lang } : { kind: 'set', lang, version }; },
        },
    },
});
const scanned = (): FeatureState => ({ toolStatuses: [], knowledgeQuery: '', toolchainCheckedAt: 1 });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-python-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => [] });
    installs = []; removals = []; managed = []; pyDefault = null;
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('Python versions through the feature IPC', () => {
    it('a scan lists them', async () => {
        managed = ['3.15.1'];
        const snap = await handleFeatureAction(services, { kind: 'toolchain.check', force: true }, scanned(), ports());
        expect(snap.toolchain!.python).toMatchObject({ managed: [{ version: '3.15.1' }], system: { version: '3.12.4' } });
    });

    it('Install WITHOUT consent is refused on its row and never reaches the installer; with consent it installs once', async () => {
        const refused = await handleFeatureAction(services, { kind: 'toolchain.installPython', version: '3.15.1', consent: false }, scanned(), ports());
        expect(installs).toEqual([]);
        expect(refused.toolchain!.refusals).toEqual([{ tool: 'python', version: '3.15.1', reason: expect.stringMatching(/without your go-ahead/) }]);
        const snap = await handleFeatureAction(services, { kind: 'toolchain.installPython', version: '3.15.1', consent: true }, { ...scanned(), toolchainRefusals: refused.toolchain!.refusals! }, ports());
        expect(snap.toolchain!.refusals).toBeUndefined();
        expect(installs).toEqual([['3.15.1', true]]);
        expect(snap.toolchain!.python!.managed.map((m) => m.version)).toEqual(['3.15.1']);
        expect(snap.toolchain!.result).toMatch(/Python 3[.]15[.]1 is installed/);
    });

    it('Remove removes it and the list no longer shows it', async () => {
        managed = ['3.15.1'];
        const snap = await handleFeatureAction(services, { kind: 'toolchain.removePython', version: '3.15.1' }, scanned(), ports());
        expect(removals).toEqual(['3.15.1']);
        expect(snap.toolchain!.python!.managed).toEqual([]);
    });
});

const render = (toolchain: FeatureData['toolchain']) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} />);
const base = { tools: [], checkedAt: 1 };

describe("Python's default (TC4a-2)", () => {
    it('Make default sets it; the DEFAULT version\'s Remove is refused and never reaches the remover', async () => {
        managed = ['3.15.1', '3.14.9'];
        const set = await handleFeatureAction(services, { kind: 'toolchain.setDefault', lang: 'python', version: '3.15.1' }, scanned(), ports());
        expect(set.toolchain!.defaults!.python).toBe('3.15.1');
        expect(set.toolchain!.result).toMatch(/Python 3[.]15[.]1 is now the default/);
        const refused = await handleFeatureAction(services, { kind: 'toolchain.removePython', version: '3.15.1' }, scanned(), ports());
        expect(removals).toEqual([]);
        expect(refused.toolchain!.refusals).toEqual([{ tool: 'python', version: '3.15.1', reason: expect.stringMatching(/is the default/) }]);
        await handleFeatureAction(services, { kind: 'toolchain.removePython', version: '3.14.9' }, scanned(), ports());
        expect(removals).toEqual(['3.14.9']);
    });

    it('the surface marks the default, offers Make default on the others, and the system\'s', () => {
        const html = render({ ...base, defaults: { node: null, go: null, php: null, python: '3.15.1', dotnet: null, rust: null }, python: { managed: [{ version: '3.15.1', dir: '/p/3.15.1' }, { version: '3.14.9', dir: '/p/3.14.9' }], system: null, available: [] } });
        expect(html).toMatch(/data-python-version="3[.]15[.]1"[^>]*data-default="true"/);
        expect(html).toMatch(/data-python-version="3[.]14[.]9"[^>]*data-default="false"[^]*?data-make-default="python:3[.]14[.]9"/);
        expect(html).not.toContain('data-make-default="python:3.15.1"');
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Python 3[.]15[.]1 is the default[^"]*"[^>]*>Remove/);
        expect(html).toContain('data-use-system="python"');
    });
});

describe('Toolchain → Python versions', () => {
    it("Genie's versions with Remove, the PATH python, and an Install per version not here", () => {
        const html = render({ ...base, python: { managed: [{ version: '3.14.9', dir: '/p/3.14.9' }], system: { version: '3.12.4' }, available: [{ version: '3.15.1', installed: false }, { version: '3.14.9', installed: true }] } });
        expect(html).toContain('data-python-versions="1"');
        expect(html).toMatch(/data-python-version="3[.]14[.]9"[^]*?>Remove</);
        expect(html).toMatch(/python on your PATH is 3[.]12[.]4/);
        expect(html).toContain('data-python-install="3.15.1"');
        expect(html).not.toContain('data-python-install="3.14.9"');
    });

    it('where Genie cannot install one, it says why and offers no Install', () => {
        const html = render({ ...base, python: { managed: [], system: null, available: [], installRefused: 'on macOS and Linux python.org publishes source only' } });
        expect(html).toContain('data-python-install-refused=""');
        expect(html).toMatch(/publishes source only/);
        expect(html).not.toContain('data-python-install=');
        expect(html).toMatch(/No python on your PATH/);
    });

    it('CONTROL: no Python view yet → no section (never an empty one)', () => {
        expect(render(base)).not.toContain('data-python-versions');
    });
});
