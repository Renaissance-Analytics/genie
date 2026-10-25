import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { RubyInstallOutcome, RubyVersionsView } from '../src/main/ruby-versions.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * GENIE'S OWN RUBY (TC6c), from the person's clicks to what they see: Settings → Toolchain lists the Ruby versions Genie
 * manages, the ruby on PATH, and an Install per version this release offers; an Install without consent never reaches the
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

const view = (): RubyVersionsView => ({
    managed: managed.map((v) => ({ version: v, dir: `/data/genie2-toolchain/ruby-versions/${v}` })),
    system: { version: '3.2.3' },
    available: [{ version: '4.0.9', installed: managed.includes('4.0.9') }, { version: '3.4.12', installed: managed.includes('3.4.12') }],
});

const ports = (): FeaturePorts => ({
    toolchain: {
        probe: async () => [],
        update: async () => ({ kind: 'refused', reason: 'n/a' }),
        now: () => 5_000,
        ruby: {
            list: async () => view(),
            install: async (version, consent): Promise<RubyInstallOutcome> => { installs.push([version, consent]); managed = [version, ...managed]; return { kind: 'installed', version, dir: `/x/${version}` }; },
            remove: (version) => { removals.push(version); managed = managed.filter((v) => v !== version); return { kind: 'removed', version }; },
        },
    },
});
const scanned = (): FeatureState => ({ toolStatuses: [], knowledgeQuery: '', toolchainCheckedAt: 1 });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-ruby-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => [] });
    installs = []; removals = []; managed = [];
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('Ruby versions through the feature IPC', () => {
    it('a scan lists them', async () => {
        managed = ['4.0.9'];
        const snap = await handleFeatureAction(services, { kind: 'toolchain.check', force: true }, scanned(), ports());
        expect(snap.toolchain!.ruby).toMatchObject({ managed: [{ version: '4.0.9' }], system: { version: '3.2.3' } });
    });

    it('Install WITHOUT consent is refused on its row and never reaches the installer; with consent it installs once', async () => {
        const refused = await handleFeatureAction(services, { kind: 'toolchain.installRuby', version: '4.0.9', consent: false }, scanned(), ports());
        expect(installs).toEqual([]);
        expect(refused.toolchain!.refusals).toEqual([{ tool: 'ruby', version: '4.0.9', reason: expect.stringMatching(/without your go-ahead/) }]);
        const snap = await handleFeatureAction(services, { kind: 'toolchain.installRuby', version: '4.0.9', consent: true }, { ...scanned(), toolchainRefusals: refused.toolchain!.refusals! }, ports());
        expect(snap.toolchain!.refusals).toBeUndefined();
        expect(installs).toEqual([['4.0.9', true]]);
        expect(snap.toolchain!.ruby!.managed.map((m) => m.version)).toEqual(['4.0.9']);
        expect(snap.toolchain!.result).toMatch(/Ruby 4\.0\.9 is installed/);
    });

    it('Remove removes it and the list no longer shows it', async () => {
        managed = ['4.0.9'];
        const snap = await handleFeatureAction(services, { kind: 'toolchain.removeRuby', version: '4.0.9' }, scanned(), ports());
        expect(removals).toEqual(['4.0.9']);
        expect(snap.toolchain!.ruby!.managed).toEqual([]);
    });
});

const render = (toolchain: FeatureData['toolchain']) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} />);
const base = { tools: [], checkedAt: 1 };

describe('Toolchain → Ruby versions', () => {
    it('Genie’s versions with Remove, the PATH ruby, and an Install per version not here', () => {
        const html = render({ ...base, ruby: { managed: [{ version: '3.4.12', dir: '/g/3.4.12' }], system: { version: '3.2.3' }, available: [{ version: '4.0.9', installed: false }, { version: '3.4.12', installed: true }] } });
        expect(html).toContain('data-ruby-versions="1"');
        expect(html).toMatch(/data-ruby-version="3\.4\.12"[^]*?>Remove</);
        expect(html).toMatch(/ruby on your PATH is 3\.2\.3/);
        expect(html).toContain('data-ruby-install="4.0.9"');
        expect(html).not.toContain('data-ruby-install="3.4.12"');
    });

    it('CONTROL: no Ruby view yet → no section (never an empty one)', () => {
        expect(render(base)).not.toContain('data-ruby-versions');
    });
});
