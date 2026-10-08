import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { startAcpAgent, type ChildLike } from '../spawn';
import { hostScriptOf } from './real-host';

/**
 * THE DECLARATION, measured on the wire from a real child — for BOTH providers.
 *
 * `session.ts` reads `particle.academy/driver_capabilities` off the `initialize` result and
 * `driver-capabilities.test.ts` pins how it reads it. Neither proves the key is THERE. That
 * depends on our host passing `driverCapabilities` to `serve()`, and prism treats an omitted
 * one as "not declared" rather than as an error — so the whole feature fails SILENTLY and
 * every unit test on both sides stays green.
 *
 * A source-text assertion would not close it either: this file's own comments name
 * `driverCapabilities`, `CLAUDE_DRIVER_CAPABILITIES` and `serve` repeatedly, so a grep for
 * those strings passes against a host that imports them and forgets to pass them.
 *
 * ## It needs no credentials, unlike its neighbours in this lane
 *
 * `initialize` is answered by the ACP agent ITSELF and never starts the provider — the
 * handshake test records the tell, *"it returned in 96 ms."* So this runs anywhere the
 * package is installed, with no Claude login and no quota spent, and it covers codex as
 * readily as claude. It lives in the acp lane only because it spawns a child.
 *
 * ## What it is really defending
 *
 * prism's maintainer: *"Claude reports `permissionRequests: false` today, and that is
 * expected to change when its permission bridge lands."* On that day this test's claude case
 * should start reporting `true` WITHOUT anyone editing Genie. That is the whole value of
 * reading a declaration instead of hard-coding a provider table — and it is why the
 * assertions below check the SHAPE and the two providers DISAGREEING, never a fixed `false`
 * that would have to be edited on upgrade.
 */

const META_KEY = 'particle.academy/driver_capabilities';

interface Declared {
    permissionRequests: boolean;
    transcriptReplay: boolean;
}

/** Spawn our host for one provider, complete `initialize`, return what it declared. */
async function declaredBy(provider: 'claude' | 'codex'): Promise<Declared | null | 'unavailable'> {
    if (hostScriptOf() === null) return 'unavailable';

    const started = startAcpAgent(
        { provider, cwd: process.cwd(), auth: 'subscription' },
        {
            spawn: (command, args, env, cwd) =>
                spawn(command, args, {
                    cwd,
                    env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true,
                }) as unknown as ChildLike,
            nodeVersion: () => process.version,
            nodeExec: () => process.execPath,
            hostScript: hostScriptOf,
            hostEnv: () => process.env as Record<string, string | undefined>,
            onStderr: (line) => {
                // A host that died on its import says so here and nowhere else.
                if (/error|cannot find|denied/i.test(line)) console.log(`[acp stderr] ${line.trim()}`);
            },
        },
    );
    if ('error' in started) throw new Error(`could not start ${provider}: ${started.error}`);

    try {
        const result = (await started.client.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
            clientInfo: { name: 'genie', version: '0.0.0-test' },
        })) as { _meta?: Record<string, unknown> };

        const declared = result?._meta?.[META_KEY];
        return (declared as Declared | undefined) ?? null;
    } finally {
        started.kill();
    }
}

describe('the host declares its driver capabilities on the wire', () => {
    it('is runnable at all, or says which precondition is missing', () => {
        // The guard against this file quietly becoming a no-op: if the host or the package
        // is absent every case below returns 'unavailable' and would read as covered.
        expect(hostScriptOf() === null ? 'prism-acp not installed' : 'ready').toBe('ready');
    });

    it('declares BOTH fields, as booleans, for claude', async () => {
        const declared = await declaredBy('claude');
        if (declared === 'unavailable') return;

        expect(declared, 'the key was absent — the host did not pass driverCapabilities').not.toBeNull();
        expect(typeof declared!.permissionRequests).toBe('boolean');
        expect(typeof declared!.transcriptReplay).toBe('boolean');
    }, 30_000);

    it('declares BOTH fields, as booleans, for codex', async () => {
        const declared = await declaredBy('codex');
        if (declared === 'unavailable') return;

        expect(declared, 'the key was absent for codex').not.toBeNull();
        expect(typeof declared!.permissionRequests).toBe('boolean');
        expect(typeof declared!.transcriptReplay).toBe('boolean');
    }, 30_000);

    it('tells the two providers APART — one constant for both would be the easy bug', async () => {
        const claude = await declaredBy('claude');
        const codex = await declaredBy('codex');
        if (claude === 'unavailable' || codex === 'unavailable') return;

        // THE POSITIVE CONTROL. `driverCapabilities` is chosen by a ternary on the provider,
        // and a ternary with the same value in both arms is indistinguishable from a correct
        // one as long as each case is only ever checked on its own. Asserting they differ is
        // what makes the ternary itself testable.
        //
        // Deliberately NOT asserting WHICH is which: claude's `permissionRequests` flips to
        // true when prism 0.7.0's bridge lands, and a test naming today's value would fail
        // on an upgrade that is working exactly as intended.
        expect(claude).not.toEqual(codex);
    }, 60_000);

    it('declares the permission capability that matches what codex actually does', async () => {
        const codex = await declaredBy('codex');
        if (codex === 'unavailable') return;

        // Codex is the provider Genie ALREADY answers `session/request_permission` for —
        // `acp/permission.ts` exists for it, and `prism-host.mjs` deliberately gives its
        // driver no permissionMode because it raises real requests. So this one value is
        // safe to pin: if it ever declared `false`, our inline approval rail would be
        // rendering a path the driver had stopped using.
        expect(codex!.permissionRequests).toBe(true);
    }, 30_000);
});
