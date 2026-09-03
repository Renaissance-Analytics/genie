import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ensureOwnedProvidersInstalled,
    ensureProviderInstalled,
    evaluateProviderInstall,
    getKnownProviderAvailability,
    launchBlockReason,
    providerWanted,
    recordProviderAvailability,
    resetProviderAvailabilityCache,
    type AvailabilityDeps,
} from '../availability';
import { agentTuis, type TuiDef } from '../registry';

/** A synthetic OWNED provider definition WITH a working `install` spec — the
 *  real registry deliberately configures none today (see `registry.ts`'s
 *  comments on `genie`/`kiwi`), so the install-attempt branches are exercised
 *  through this rather than any live registry entry. */
function ownedProviderWithInstaller(): TuiDef {
    return {
        id: 'genie',
        label: 'Genie TUI',
        hint: 'Launch the local-first Genie TUI',
        defaultCommand: 'genie',
        commandSettingKey: 'agent_command_genie',
        flagsSettingKey: 'agent_flags_genie',
        ownedBinary: true,
        install: { manager: 'npm', package: 'some-future-genie-tui-package' },
        // Availability is about the BINARY existing; resume grammar plays no
        // part in it. Mirrors the real `genie` entry rather than inventing one.
        resume: null,
    };
}

/**
 * genie#313 — "Genie's boot should detect whether the TUI is installed, and
 * install it if it is not — but only when it is actually wanted: only if there
 * is a workspace, or only if the Genie OSA is configured to use it."
 *
 * These are ALL pure / dependency-injected, so no filesystem, no child_process,
 * no Electron. The real IO (a `where`/`which` probe, an `npm install -g`) lives
 * in the effects module and is deliberately untested here — the same split
 * `main/dev-server/seams.ts` and its callers already use.
 */

describe('providerWanted — the gate genie#313 asks for', () => {
    it('is never wanted for a provider Genie does not own, no matter the context', () => {
        for (const id of ['claude', 'codex', 'custom'] as const) {
            expect(providerWanted(id, { hasWorkspace: true, osaProvider: id })).toBe(false);
        }
    });

    it('wants an owned provider when a workspace exists, even if the OSA uses something else', () => {
        expect(providerWanted('genie', { hasWorkspace: true, osaProvider: 'claude' })).toBe(true);
        expect(providerWanted('kiwi', { hasWorkspace: true, osaProvider: 'claude' })).toBe(true);
    });

    it('wants an owned provider when the OSA is configured to use it, even with zero workspaces', () => {
        expect(providerWanted('genie', { hasWorkspace: false, osaProvider: 'genie' })).toBe(true);
        expect(providerWanted('kiwi', { hasWorkspace: false, osaProvider: 'kiwi' })).toBe(true);
    });

    it('does NOT want an owned provider that nothing could ever launch', () => {
        // Zero workspaces AND the OSA is on a different provider entirely — the
        // exact host genie#313 says must not get an install attempt.
        expect(providerWanted('genie', { hasWorkspace: false, osaProvider: 'claude' })).toBe(false);
        expect(providerWanted('kiwi', { hasWorkspace: false, osaProvider: 'claude' })).toBe(false);
    });

    it('does not cross-want a DIFFERENT owned provider from the OSA setting', () => {
        // The OSA is configured for `genie`; that must not also mark `kiwi`
        // wanted on a workspace-less host.
        expect(providerWanted('kiwi', { hasWorkspace: false, osaProvider: 'genie' })).toBe(false);
    });
});

function fakeDeps(overrides: Partial<AvailabilityDeps> = {}): AvailabilityDeps {
    return {
        resolveOnPath: vi.fn(async () => undefined),
        runInstall: vi.fn(async () => ({ ok: false, detail: 'not attempted' })),
        ...overrides,
    };
}

describe('ensureProviderInstalled', () => {
    it('never probes or installs a provider that is not wanted', async () => {
        const deps = fakeDeps();
        const result = await ensureProviderInstalled(
            'genie',
            { hasWorkspace: false, osaProvider: 'claude' },
            deps,
        );
        expect(result).toEqual({ id: 'genie', status: 'not-wanted' });
        expect(deps.resolveOnPath).not.toHaveBeenCalled();
        expect(deps.runInstall).not.toHaveBeenCalled();
    });

    it('reports available when the binary already resolves on PATH — no install attempted', async () => {
        const deps = fakeDeps({
            resolveOnPath: vi.fn(async (bin: string) =>
                bin === 'genie' ? 'C:\\Users\\glenn\\AppData\\Roaming\\npm\\genie.cmd' : undefined,
            ),
        });
        const result = await ensureProviderInstalled(
            'genie',
            { hasWorkspace: true, osaProvider: 'claude' },
            deps,
        );
        expect(result).toEqual({
            id: 'genie',
            status: 'available',
            command: 'C:\\Users\\glenn\\AppData\\Roaming\\npm\\genie.cmd',
        });
        expect(deps.runInstall).not.toHaveBeenCalled();
    });

    it('surfaces a clear reason — and does not attempt an install — when the provider has no installer', async () => {
        // This is `genie` and `kiwi`'s REAL state today (registry.ts): owned,
        // wanted, missing, but with no working install source yet.
        const deps = fakeDeps();
        const result = await ensureProviderInstalled(
            'genie',
            { hasWorkspace: true, osaProvider: 'claude' },
            deps,
        );
        expect(result.status).toBe('unavailable');
        expect(result).toMatchObject({
            id: 'genie',
            reason: expect.stringContaining('does not have an automatic installer'),
        });
        expect(deps.runInstall).not.toHaveBeenCalled();
    });

    it('never attempts an install for the REAL registry\'s genie/kiwi — neither has one configured', async () => {
        // Documents, at the orchestrator level, exactly what `registry.ts`'s
        // comments say: today's `genie` and `kiwi` entries carry no `install`,
        // so a boot pass against the real registry can only detect, never
        // install. The install-attempt branches below are proven correct
        // against a SYNTHETIC def instead (`ownedProviderWithInstaller`).
        const runInstall = vi.fn(async () => ({ ok: false, detail: 'should never run' }));
        for (const id of ['genie', 'kiwi'] as const) {
            const result = await ensureProviderInstalled(
                id,
                { hasWorkspace: true, osaProvider: 'claude' },
                fakeDeps({ runInstall }),
            );
            expect(result.status, id).toBe('unavailable');
        }
        expect(runInstall).not.toHaveBeenCalled();
    });
});

describe('evaluateProviderInstall — the install-attempt branches', () => {
    it('attempts install, then RE-PROBES rather than trusting the installer\'s own success', async () => {
        // The Windows ".cmd shim" / "a PID is not proof a binary ran" lesson
        // applies just as much to an install step as to a launch: an installer
        // can exit 0 without leaving anything resolvable on PATH.
        const resolveOnPath = vi
            .fn<AvailabilityDeps['resolveOnPath']>()
            .mockResolvedValueOnce(undefined) // pre-install probe: missing
            .mockResolvedValueOnce(undefined); // post-install probe: STILL missing
        const runInstall = vi.fn(async () => ({ ok: true, detail: 'exit 0' }));
        const deps = fakeDeps({ resolveOnPath, runInstall });

        const result = await evaluateProviderInstall(ownedProviderWithInstaller(), deps);

        expect(runInstall).toHaveBeenCalledTimes(1);
        expect(resolveOnPath).toHaveBeenCalledTimes(2);
        expect(result.status).toBe('unavailable');
        expect(result).toMatchObject({
            reason: expect.stringContaining('still does not resolve on PATH'),
        });
    });

    it('reports installed once a successful install actually resolves on PATH', async () => {
        const resolveOnPath = vi
            .fn<AvailabilityDeps['resolveOnPath']>()
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce('/usr/local/bin/genie');
        const runInstall = vi.fn(async () => ({ ok: true, detail: 'exit 0' }));
        const deps = fakeDeps({ resolveOnPath, runInstall });

        const result = await evaluateProviderInstall(ownedProviderWithInstaller(), deps);

        expect(result).toEqual({ id: 'genie', status: 'installed', command: '/usr/local/bin/genie' });
    });

    it('surfaces the installer\'s own failure detail when it fails outright', async () => {
        const runInstall = vi.fn(async () => ({ ok: false, detail: 'npm error 404 Not Found' }));
        const deps = fakeDeps({ runInstall });

        const result = await evaluateProviderInstall(ownedProviderWithInstaller(), deps);

        expect(result).toEqual({
            id: 'genie',
            status: 'unavailable',
            reason: expect.stringContaining('npm error 404 Not Found'),
        });
    });
});

describe('ensureOwnedProvidersInstalled — the boot-time sweep', () => {
    it('records a result for every owned provider and skips the rest entirely', async () => {
        resetProviderAvailabilityCache();
        const deps = fakeDeps({
            resolveOnPath: vi.fn(async () => undefined),
        });
        const results = await ensureOwnedProvidersInstalled(
            { hasWorkspace: true, osaProvider: 'claude' },
            deps,
        );

        const ids = results.map((r) => r.id).sort();
        expect(ids).toEqual([...agentTuis()].sort());

        // Non-owned providers never touch resolveOnPath at all.
        const nonOwnedCalls = (deps.resolveOnPath as ReturnType<typeof vi.fn>).mock.calls
            .map(([bin]) => bin);
        expect(nonOwnedCalls).not.toContain('claude');
        expect(nonOwnedCalls).not.toContain('codex');

        expect(getKnownProviderAvailability('genie')?.status).toBe('unavailable');
        expect(getKnownProviderAvailability('claude')?.status).toBe('not-wanted');
    });
});

describe('launchBlockReason — consulted synchronously at launch time', () => {
    beforeEach(() => {
        resetProviderAvailabilityCache();
    });

    it('fails OPEN when nothing has been recorded yet', () => {
        expect(launchBlockReason('genie')).toBeUndefined();
    });

    it('fails open for a status that is not "unavailable"', () => {
        recordProviderAvailability({ id: 'genie', status: 'not-wanted' });
        expect(launchBlockReason('genie')).toBeUndefined();
        recordProviderAvailability({ id: 'genie', status: 'available', command: 'genie' });
        expect(launchBlockReason('genie')).toBeUndefined();
    });

    it('blocks with the recorded reason once the boot pass marked a provider unavailable', () => {
        recordProviderAvailability({ id: 'genie', status: 'unavailable', reason: 'nope' });
        expect(launchBlockReason('genie')).toBe('nope');
        // Unrelated providers are unaffected.
        expect(launchBlockReason('kiwi')).toBeUndefined();
    });
});
