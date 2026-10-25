import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DefaultLang } from '../src/core/toolchain-defaults.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * CHOOSING A DEFAULT, from the click to what the person sees (plan `.ai/plans/genie-2-toolchain-rest.md`, TC3a): each
 * managed version shows whether it is the default, and "Make default" on the others; "Use the system's" clears it; the
 * default version's Remove is refused (it is what `go` means right now — choose another default first). Fakes that count.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};

let dir: string;
let services: ComposedServices;
let defaults: Record<DefaultLang, string | null>;
let sets: Array<[DefaultLang, string | null]>;
let removals: string[];

const ports = (): FeaturePorts => ({
    toolchain: {
        probe: async () => [],
        update: async () => ({ kind: 'refused', reason: 'n/a' }),
        now: () => 5_000,
        go: {
            list: async () => ({ managed: [{ version: '1.27.3', dir: '/g/1.27.3' }, { version: '1.26.10', dir: '/g/1.26.10' }], system: null, available: [] }),
            install: async () => ({ kind: 'refused', reason: 'n/a' }),
            remove: (version) => { removals.push(version); return { kind: 'removed', version }; },
        },
        defaults: {
            list: () => ({ ...defaults }),
            set: (lang, version) => { sets.push([lang, version]); defaults = { ...defaults, [lang]: version }; return version === null ? { kind: 'cleared', lang } : { kind: 'set', lang, version }; },
        },
    },
});
const scanned = (): FeatureState => ({ toolStatuses: [], knowledgeQuery: '', toolchainCheckedAt: 1 });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-defaults-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => [] });
    defaults = { node: null, go: '1.27.3', php: null, python: null, dotnet: null };
    sets = []; removals = [];
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('defaults through the feature IPC', () => {
    it('a scan carries the defaults; Make default sets one; Use the system’s clears it', async () => {
        const snap = await handleFeatureAction(services, { kind: 'toolchain.check', force: true }, scanned(), ports());
        expect(snap.toolchain!.defaults).toEqual({ node: null, go: '1.27.3', php: null, python: null, dotnet: null });
        const set = await handleFeatureAction(services, { kind: 'toolchain.setDefault', lang: 'go', version: '1.26.10' }, scanned(), ports());
        expect(sets).toEqual([['go', '1.26.10']]);
        expect(set.toolchain!.defaults!.go).toBe('1.26.10');
        expect(set.toolchain!.result).toMatch(/Go 1\.26\.10 is now the default/);
        const cleared = await handleFeatureAction(services, { kind: 'toolchain.setDefault', lang: 'go', version: null }, scanned(), ports());
        expect(cleared.toolchain!.defaults!.go).toBeNull();
    });

    it('the DEFAULT version’s Remove is refused and never reaches the remover; another version removes', async () => {
        const refused = await handleFeatureAction(services, { kind: 'toolchain.removeGo', version: '1.27.3' }, scanned(), ports());
        expect(removals).toEqual([]);
        expect(refused.toolchain!.refusals).toEqual([{ tool: 'go', version: '1.27.3', reason: expect.stringMatching(/is the default/) }]);
        await handleFeatureAction(services, { kind: 'toolchain.removeGo', version: '1.26.10' }, scanned(), ports());
        expect(removals).toEqual(['1.26.10']);
    });
});

const render = (toolchain: FeatureData['toolchain']) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} />);

describe('Toolchain → Go versions shows the default', () => {
    it('the default version is marked (and its Remove disabled with the reason); the others offer Make default; the system’s is offered', () => {
        const html = render({ tools: [], checkedAt: 1, defaults: { node: null, go: '1.27.3', php: null, python: null, dotnet: null }, go: { managed: [{ version: '1.27.3', dir: '/g/1.27.3' }, { version: '1.26.10', dir: '/g/1.26.10' }], system: { version: '1.22.2' }, available: [] } });
        expect(html).toMatch(/data-go-version="1\.27\.3"[^>]*data-default="true"/);
        expect(html).toMatch(/data-go-version="1\.26\.10"[^>]*data-default="false"[^]*?data-make-default="go:1\.26\.10"/);
        expect(html).not.toContain('data-make-default="go:1.27.3"');
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Go 1\.27\.3 is the default[^"]*"[^>]*>Remove/);
        expect(html).toContain('data-use-system="go"');
    });

    it('CONTROL: no default → nothing marked, every version offers Make default, no "use the system’s" button', () => {
        const html = render({ tools: [], checkedAt: 1, defaults: { node: null, go: null, php: null, python: null, dotnet: null }, go: { managed: [{ version: '1.27.3', dir: '/g/1.27.3' }], system: null, available: [] } });
        expect(html).toContain('data-make-default="go:1.27.3"');
        expect(html).not.toContain('data-use-system="go"');
    });
});
