import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * THE MACHINE-PATH SWITCH, from the click to what the person sees (plan TC3b): Settings → Toolchain says EXACTLY what
 * would change (the entries, and where) before anything does; Apply is the person's consent; Undo puts it back. Fakes
 * that count.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};

let dir: string;
let services: ComposedServices;
let applied: boolean;
let calls: string[];
const ENTRIES = ['/h/.genie/genie2-toolchain/current/node/bin', '/h/.genie/genie2-toolchain/current/go/bin'];

const ports = (): FeaturePorts => ({
    toolchain: {
        probe: async () => [],
        update: async () => ({ kind: 'refused', reason: 'n/a' }),
        now: () => 5_000,
        machinePath: {
            status: async () => ({ applied, where: applied ? ['/h/.profile'] : [], entries: ENTRIES, targets: ['/h/.profile'] }),
            apply: async (consent) => { calls.push(`apply ${consent}`); if (!consent) return { kind: 'refused', reason: 'Genie changes your PATH only with your go-ahead; nothing was changed' }; applied = true; return { kind: 'applied', where: ['/h/.profile'] }; },
            remove: async () => { calls.push('remove'); applied = false; return { kind: 'removed', where: ['/h/.profile'] }; },
        },
    },
});
const scanned = (): FeatureState => ({ toolStatuses: [], knowledgeQuery: '', toolchainCheckedAt: 1 });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-machpath-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => [] });
    applied = false; calls = [];
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the machine PATH through the feature IPC', () => {
    it('a scan carries its status; Apply WITHOUT consent never changes it; with consent it applies; Undo removes it', async () => {
        const snap = await handleFeatureAction(services, { kind: 'toolchain.check', force: true }, scanned(), ports());
        expect(snap.toolchain!.machinePath).toEqual({ applied: false, where: [], entries: ENTRIES, targets: ['/h/.profile'] });
        const refused = await handleFeatureAction(services, { kind: 'toolchain.machinePath', apply: true, consent: false }, scanned(), ports());
        expect(applied).toBe(false);
        expect(refused.toolchain!.refusals).toEqual([{ tool: 'machine-path', reason: expect.stringMatching(/go-ahead/) }]);
        const done = await handleFeatureAction(services, { kind: 'toolchain.machinePath', apply: true, consent: true }, scanned(), ports());
        expect(done.toolchain!.machinePath!.applied).toBe(true);
        expect(done.toolchain!.result).toMatch(/terminals outside Genie/);
        const undone = await handleFeatureAction(services, { kind: 'toolchain.machinePath', apply: false, consent: true }, scanned(), ports());
        expect(undone.toolchain!.machinePath!.applied).toBe(false);
        expect(calls).toEqual(['apply false', 'apply true', 'remove']);
    });
});

const render = (toolchain: FeatureData['toolchain']) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} />);

describe('Toolchain → Your terminals', () => {
    it('not applied: says exactly what would change and where, before anything does, and offers the one button', () => {
        const html = render({ tools: [], checkedAt: 1, machinePath: { applied: false, where: [], entries: ENTRIES, targets: ['/h/.profile', '/h/.bashrc'] } });
        expect(html).toContain('data-machine-path="off"');
        for (const e of ENTRIES) expect(html).toContain(e);
        expect(html).toContain('/h/.bashrc');
        expect(html).toContain('data-machine-path-apply');
    });

    it('applied: says where, and offers Undo instead', () => {
        const html = render({ tools: [], checkedAt: 1, machinePath: { applied: true, where: ['/h/.profile'], entries: ENTRIES, targets: ['/h/.profile'] } });
        expect(html).toContain('data-machine-path="on"');
        expect(html).toContain('data-machine-path-undo');
        expect(html).not.toContain('data-machine-path-apply');
    });

    it('CONTROL: no status read yet → no card', () => {
        expect(render({ tools: [], checkedAt: 1 })).not.toContain('data-machine-path');
    });
});
