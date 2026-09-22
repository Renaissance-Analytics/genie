import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ensureOwnedProvidersInstalled,
    ensureProviderInstalled,
    evaluateProviderInstall,
    getKnownProviderAvailability,
    launchBlockReason,
    providerWanted,
    recordProviderAvailability,
    refreshProviderAvailability,
    resetProviderAvailabilityCache,
    type AvailabilityDeps,
} from '../availability';
import { agentTuis, providerDef, type TuiDef } from '../registry';
import { agentCliForProvider } from '../agent-cli-catalog';

/** A synthetic OWNED provider definition WITH a working `install` spec — the
 *  real registry deliberately configures none today (see `registry.ts`'s
 *  comments on `genie`), so the install-attempt branches are exercised
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

    /**
     * `genie` is now the ONLY owned provider, and that is a correction rather
     * than a loss. `kiwi` used to claim `ownedBinary: true` under a comment
     * saying "Genie ships this one" — which was never true of anything, and is
     * certainly not true of Kilo Code, the real product it turned out to mean.
     * Genie must not run an unattended `npm i -g` over another vendor's CLI, so
     * every third-party provider is unowned by construction.
     */
    it('wants the owned provider when a workspace exists, even if the OSA uses something else', () => {
        expect(providerWanted('genie', { hasWorkspace: true, osaProvider: 'claude' })).toBe(true);
    });

    it('wants the owned provider when the OSA is configured to use it, even with zero workspaces', () => {
        expect(providerWanted('genie', { hasWorkspace: false, osaProvider: 'genie' })).toBe(true);
    });

    it('does NOT want an owned provider that nothing could ever launch', () => {
        // Zero workspaces AND the OSA is on a different provider entirely — the
        // exact host genie#313 says must not get an install attempt.
        expect(providerWanted('genie', { hasWorkspace: false, osaProvider: 'claude' })).toBe(false);
    });

    it('does not want the owned provider just because the OSA names an UNOWNED one', () => {
        // The cross-want case, expressed with the registry as it is: an OSA set
        // to a third-party CLI on a workspace-less host must not drag Genie's
        // own TUI into the install pass.
        expect(providerWanted('genie', { hasWorkspace: false, osaProvider: 'kilo' })).toBe(false);
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

    it('INSTALLS the Genie TUI when it is wanted and missing', async () => {
        // This test used to assert the opposite, on the premise that `genie` was
        // "owned, wanted, missing, but with no working install source yet".
        // That premise expired: the release-tarball installer landed in the
        // agent-CLI catalog and is measured end to end in
        // `genie-tui-install-gap.test.ts`. What kept the old behaviour alive was
        // that this module read a SECOND table (`TuiDef.install`) which no row
        // ever set — so the fix is one table, and the new contract is that a
        // wanted, missing provider the catalog CAN install is installed.
        const runInstall = vi.fn(async () => ({ ok: true, detail: 'added 255 packages' }));
        let probes = 0;
        const deps = fakeDeps({
            runInstall,
            resolveOnPath: vi.fn(async () => (probes++ === 0 ? undefined : '/usr/local/bin/genie')),
        });
        const result = await ensureProviderInstalled(
            'genie',
            { hasWorkspace: true, osaProvider: 'claude' },
            deps,
        );
        expect(runInstall).toHaveBeenCalledWith(agentCliForProvider('genie')!.install);
        expect(result).toMatchObject({ id: 'genie', status: 'installed' });
    });

    it('never installs a CLI Genie does not OWN, whatever the catalog says about it', async () => {
        // THE SAFETY PROPERTY, which did not change and is the reason this test
        // exists: an unattended boot pass must never `npm i -g` over another
        // vendor's CLI. The catalog carries working installers for several of
        // them (claude-code, codex, iflow…), so "it did not install anything"
        // can no longer be asserted by the absence of install specs — the gate
        // is `providerWanted`, and this proves the gate rather than the gap.
        //
        // It used to assert that NOTHING is ever installed, justified by "no
        // entry carries a TuiDef.install". That was describing the bug: the
        // field was unset everywhere, which is why Genie could not install its
        // own TUI at boot either.
        const runInstall = vi.fn(async () => ({ ok: false, detail: 'should never run' }));
        const installed: string[] = [];
        for (const id of agentTuis()) {
            const result = await ensureProviderInstalled(
                id,
                { hasWorkspace: true, osaProvider: 'claude' },
                fakeDeps({ runInstall }),
            );
            if (result.status !== 'not-wanted') installed.push(id);
        }
        // `genie` is the only provider Genie owns, so it is the only one the
        // unattended pass may ever touch.
        expect(installed).toEqual(['genie']);
        expect(runInstall).toHaveBeenCalledTimes(1);
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
        expect(launchBlockReason('kilo')).toBeUndefined();
    });
});

/**
 * THE DEFECT the owner reported as "our TUI install workflows still don't work
 * properly, at least not for genie tui".
 *
 * Genie kept TWO install tables. `AgentCliDef.install`
 * (`agent-cli-catalog.ts`) is the maintained one — it carries a release-tarball
 * installer for the Genie TUI that `genie-tui-install-gap.test.ts` measured end
 * to end. `TuiDef.install` (`registry.ts`) is the one this module read, and NO
 * ROW HAS EVER SET IT. So the boot pass took the `!def.install` branch every
 * time a binary was missing, `runInstall` was dead code in production, and the
 * owner was told "Genie does not have an automatic installer for it yet" —
 * moments after the Toolchain page had installed it.
 *
 * Worse, it is not a degraded experience but a hard block: `launchBlockReason`
 * reads this result, and `createAgentTerminal` THROWS on it before a pty is
 * opened. There was no path out of it from that surface.
 *
 * Every test above this line runs against a SYNTHETIC provider carrying an
 * install spec, which is exactly why none of them could catch it — the fixture
 * supplied the field the real table was missing. These run against the real
 * registry and the real catalog.
 */
describe('the install spec comes from the ONE maintained table', () => {
    beforeEach(() => {
        resetProviderAvailabilityCache();
    });

    it('ATTEMPTS the catalog installer for the Genie TUI when its binary is missing', async () => {
        const runInstall = vi.fn(async () => ({ ok: true, detail: 'added 255 packages' }));
        // Missing on the first probe, present after the install — the sequence a
        // real install produces.
        let probes = 0;
        const resolveOnPath = vi.fn(async () => (probes++ === 0 ? undefined : '/usr/local/bin/genie'));
        const result = await evaluateProviderInstall(providerDef('genie'), fakeDeps({ runInstall, resolveOnPath }));

        // It ran the installer the CATALOG carries — the release tarball proven
        // in genie-tui-install-gap.test.ts, not a package name invented here.
        expect(runInstall).toHaveBeenCalledWith(agentCliForProvider('genie')!.install);
        expect(result).toEqual({ id: 'genie', status: 'installed', command: '/usr/local/bin/genie' });
    });

    it('never claims Genie has no installer for a provider the catalog CAN install', async () => {
        // Asserting on the REASON, not only the status. With the bug, the status
        // was 'unavailable' — and it is STILL 'unavailable' when a working
        // installer runs and the re-probe finds nothing. A status-only assertion
        // passes either way and cannot distinguish the failure it names.
        const result = await evaluateProviderInstall(providerDef('genie'), fakeDeps());

        expect(result).toMatchObject({ status: 'unavailable' });
        expect('reason' in result && result.reason).not.toMatch(/does not have an automatic installer/i);
    });

    it('POSITIVE CONTROL: still refuses for a provider the catalog genuinely cannot install', async () => {
        // Otherwise "it does not say there is no installer" would pass against a
        // version that simply deleted the message. Goose ships as a GitHub
        // release binary, and the catalog says so in the user's words — that
        // sentence is the one worth showing, not a generic line.
        const runInstall = vi.fn(async () => ({ ok: true, detail: 'should never run' }));
        const result = await evaluateProviderInstall(providerDef('goose'), fakeDeps({ runInstall }));

        expect(runInstall).not.toHaveBeenCalled();
        expect('reason' in result && result.reason).toContain('GitHub release binary');
    });

    it('probes the command the OWNER configured, not the default', async () => {
        // `background.ts` launches `osSettings[commandSettingKey] || defaultCommand`
        // but the probe read `defaultCommand` alone, so an owner who pointed
        // `agent_command_genie` at a full path was marked unavailable — and then
        // blocked from a launch that would have worked.
        const resolveOnPath = vi.fn(async (bin: string) =>
            bin === '/opt/genie/bin/genie' ? bin : undefined,
        );
        const result = await evaluateProviderInstall(
            providerDef('genie'),
            fakeDeps({ resolveOnPath }),
            '/opt/genie/bin/genie',
        );

        expect(result).toEqual({
            id: 'genie',
            status: 'available',
            command: '/opt/genie/bin/genie',
        });
    });
});

/**
 * The block has to LIFT when the gap closes.
 *
 * `lastKnown` is written once, by the boot sweep, and nothing else ever touched
 * it outside tests. So installing the Genie TUI from the Toolchain page left
 * `launchBlockReason` still refusing every launch — with a message saying Genie
 * had no installer — until the app was restarted, moments after Genie had
 * installed it. A cache that outlives the fact it caches is worse than no cache:
 * it turns a fixed problem into an unfixable-looking one.
 */
describe('refreshProviderAvailability — after a deliberate install', () => {
    beforeEach(() => {
        resetProviderAvailabilityCache();
    });

    it('lifts the launch block once the binary really is on PATH', async () => {
        recordProviderAvailability({
            id: 'genie',
            status: 'unavailable',
            reason: 'Genie TUI is not installed, and Genie does not have an automatic installer for it yet.',
        });
        expect(launchBlockReason('genie')).toBeDefined();

        await refreshProviderAvailability(
            'genie',
            fakeDeps({ resolveOnPath: vi.fn(async () => '/usr/local/bin/genie') }),
        );

        expect(launchBlockReason('genie')).toBeUndefined();
    });

    it('does NOT install — the person already did, this only re-probes', async () => {
        // A refresh that could install would turn "I just installed it" into a
        // second unattended `npm i -g` behind the user's back.
        const runInstall = vi.fn(async () => ({ ok: true, detail: 'should never run' }));
        await refreshProviderAvailability('genie', fakeDeps({ runInstall }));
        expect(runInstall).not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL: keeps the block when the binary is still missing', async () => {
        // Otherwise "the block lifted" would pass against a refresh that simply
        // cleared the cache without checking anything.
        await refreshProviderAvailability(
            'genie',
            fakeDeps({ resolveOnPath: vi.fn(async () => undefined) }),
        );
        expect(launchBlockReason('genie')).toBeDefined();
    });
});

/**
 * AN UNATTENDED NETWORK INSTALL NEEDS A GATE, and the E2E suite is the case
 * that proved it.
 *
 * Wiring the boot pass to the catalog gave it, for the first time, a real
 * installer to run — so a boot that finds `genie` missing now fires
 * `npm install --global <tarball>` by itself. That is what genie#313 asked for
 * on a person's machine, and it is wrong in a clean VM: the E2E suite launches
 * the app many times per run, and each launch would start a 255-package network
 * install that nothing in the suite is testing, holding handles into teardown.
 *
 * This is NOT "turn it off to make CI green". A test VM installing the product's
 * own TUI from the network on every app launch is a hermeticity bug in its own
 * right — the suite would depend on GitHub being up to test a window opening.
 * The gate lives in `providerWanted`, with the other reasons not to install, so
 * it is one pure decision rather than a condition sprinkled at the call site.
 */
describe('providerWanted — unattended installs need consent from the context', () => {
    it('does not want an install when the host has opted out of unattended ones', () => {
        expect(
            providerWanted('genie', {
                hasWorkspace: true,
                osaProvider: 'genie',
                unattendedInstalls: false,
            }),
        ).toBe(false);
    });

    it('POSITIVE CONTROL: the same provider IS wanted when they are allowed', () => {
        // Otherwise the assertion above would pass against a `providerWanted`
        // that had simply stopped wanting anything.
        expect(
            providerWanted('genie', {
                hasWorkspace: true,
                osaProvider: 'genie',
                unattendedInstalls: true,
            }),
        ).toBe(true);
    });

    it('defaults to ALLOWED when the caller says nothing', () => {
        // The desktop boot is the caller that matters and it wants them; an
        // omitted flag must not silently disable the feature genie#313 asked for.
        expect(providerWanted('genie', { hasWorkspace: true, osaProvider: 'genie' })).toBe(true);
    });
});
