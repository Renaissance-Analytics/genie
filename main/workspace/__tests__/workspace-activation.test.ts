import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initDatabase, observeActiveWorkspace, setSettings } from '../../db';
import {
    activateRestoredWorkspace,
    createWorkspaceActivation,
    watchActiveWorkspace,
    workspaceActivated,
    workspaceActivationIdleForTests,
} from '../activate';
import { initDevLifecycle, resetDevLifecycleForTests } from '../../dev-server/lifecycle';
import type { DevServerLifecycle, DevServerLifecycleDeps } from '../../dev-server/lifecycle';
import type { DevServiceManager } from '../../dev-server/services/service-manager';
import type { DevServiceConfig, DevServices } from '../../dev-server/services/services-config';

/**
 * THE WORKSPACE THE USER IS ACTUALLY IN (genie#597).
 *
 * `devLifecycle().onWorkspaceOpen` had exactly one caller — `openWorkspace()`,
 * reached from the tray, the Add Workspace modal and MCP. The two paths a person
 * actually takes reach none of it: the master window's workspace switch writes
 * `active_workspace` through `settings:set` and stops there, and the launch
 * restore reads that setting and writes nothing at all. So on the ordinary
 * journey — quit, relaunch, land in your workspace, open a terminal — #559's
 * deferred adoption pass and #573's host-native service start were both wired to
 * a door most people never use.
 *
 * The seam is the WRITE: `setSettings` is the one place `active_workspace`
 * changes, whoever changed it — the IPC handler, the phone/remote settings
 * route, `openWorkspace` itself, anything added later. A change there notifies,
 * and the notice runs the same hook the tray runs. The launch restore is the one
 * case that write cannot cover, because it does not write; boot takes it from
 * the persisted value instead.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-ws-activation-'));
initDatabase(dataDir);

const WS = { id: 'ws-a', path: dataDir, label: 'Acme' };
const OTHER = { id: 'ws-b', path: dataDir, label: 'Beta' };

/** A stand-in for the service manager: only the two verbs open calls. */
function fakeServices() {
    const acquired: string[] = [];
    let deferredPasses = 0;
    return {
        acquired,
        passes: () => deferredPasses,
        manager: {
            async acquireHostNative(workspaceId: string) {
                acquired.push(workspaceId);
            },
            async adoptIfDeferred() {
                deferredPasses += 1;
            },
        } as unknown as DevServiceManager,
    };
}

/** A REAL lifecycle over fakes: no container runtime, so open stops after the
 *  two service verbs and never touches Docker. */
function realLifecycleOver(services: DevServiceManager): DevServerLifecycle {
    const workspaces = [WS, OTHER];
    const deps: DevServerLifecycleDeps = {
        resolveRuntime: async () => ({
            runtime: null,
            detection: { kind: 'none', reason: 'not-installed', probes: [] },
        }),
        workspaceFor: (id) => workspaces.find((w) => w.id === id) ?? null,
        devSitesFor: () => ({}),
        // Every workspace here USES the dev server — the gate is tested in
        // lifecycle.test.ts; what is under test here is reachability.
        devServicesFor: (): DevServices => ({ websockets: {} as DevServiceConfig }),
        sites: () => null,
        services: () => services,
    };
    return initDevLifecycle(deps);
}

afterEach(async () => {
    await workspaceActivationIdleForTests();
    observeActiveWorkspace(null);
    resetDevLifecycleForTests();
});

describe('a workspace becoming active opens it (genie#597)', () => {
    beforeEach(() => {
        // A settled starting point that is NOT either fixture, so the first
        // write in each test is a real change.
        observeActiveWorkspace(null);
        setSettings({ active_workspace: 'ws-none' });
    });

    it('a plain settings write of active_workspace opens it — the master-window switch', async () => {
        const services = fakeServices();
        realLifecycleOver(services.manager);
        watchActiveWorkspace();

        // Exactly what `renderer/pages/master.tsx`'s `activateWorkspace` does,
        // through `settings:set` → `setSettings`. Before genie#597 this ran no
        // dev-server work whatsoever.
        setSettings({ active_workspace: WS.id });
        await workspaceActivationIdleForTests();

        expect(services.acquired).toEqual([WS.id]);
        // What genie#597 changes is REACHABILITY, and `acquired` is the proof
        // the hook body ran. Everything else hung off that moment rides the same
        // call: #559's owed adoption pass is two lines further down, gated on a
        // container runtime existing — which this fixture deliberately has none
        // of, so nothing here can touch Docker. Its own behaviour is
        // `lifecycle.test.ts` → "takes the adoption pass a Docker-less boot
        // could not".
        expect(services.passes()).toBe(0);
    });

    it('does NOT open again when the write leaves the active workspace unchanged', async () => {
        const services = fakeServices();
        realLifecycleOver(services.manager);
        watchActiveWorkspace();

        setSettings({ active_workspace: WS.id });
        await workspaceActivationIdleForTests();
        // The rail re-writes the active workspace on a click that changes
        // nothing; that must not re-ensure a sandbox or re-take an adoption pass.
        setSettings({ active_workspace: WS.id });
        await workspaceActivationIdleForTests();

        expect(services.acquired).toEqual([WS.id]);
    });

    it('ignores a write that does not touch active_workspace — settings:set is a hot path', async () => {
        const services = fakeServices();
        realLifecycleOver(services.manager);
        watchActiveWorkspace();

        setSettings({ max_views: '6' });
        setSettings({ view_state_json: '{}' });
        await workspaceActivationIdleForTests();

        expect(services.acquired).toEqual([]);
        expect(services.passes()).toBe(0);
    });

    it('opens the workspace the LAUNCH RESTORE lands in, which writes nothing', async () => {
        // Seed the setting with no observer installed — a previous session's
        // quit, as the next launch finds it.
        setSettings({ active_workspace: OTHER.id });

        const services = fakeServices();
        realLifecycleOver(services.manager);
        activateRestoredWorkspace();
        await workspaceActivationIdleForTests();

        expect(services.acquired).toEqual([OTHER.id]);
    });
});

describe('the activation itself', () => {
    /** A lifecycle whose open is a promise the test resolves by hand. One
     *  resolver per call — two concurrent passes must both be releasable. */
    function deferredLifecycle() {
        const calls: string[] = [];
        const pending: Array<() => void> = [];
        const lifecycle = {
            onWorkspaceOpen: (id: string) => {
                calls.push(id);
                return new Promise<void>((resolve) => pending.push(() => resolve()));
            },
        } as unknown as DevServerLifecycle;
        return {
            calls,
            lifecycle,
            release: () => {
                for (const r of pending.splice(0)) r();
            },
        };
    }

    it('coalesces concurrent passes for the SAME workspace', async () => {
        const { calls, lifecycle, release } = deferredLifecycle();
        const activation = createWorkspaceActivation({ lifecycle: () => lifecycle });

        activation.activated(WS.id);
        activation.activated(WS.id);
        expect(calls).toEqual([WS.id]);

        release();
        await activation.idle();
        // …and a LATER activation is a fresh pass: a tray open of the workspace
        // you are already in still warms its sandbox.
        activation.activated(WS.id);
        expect(calls).toEqual([WS.id, WS.id]);
        release();
        await activation.idle();
    });

    it('does not coalesce DIFFERENT workspaces', async () => {
        const { calls, lifecycle, release } = deferredLifecycle();
        const activation = createWorkspaceActivation({ lifecycle: () => lifecycle });

        activation.activated(WS.id);
        activation.activated(OTHER.id);

        expect(calls).toEqual([WS.id, OTHER.id]);
        release();
        await activation.idle();
    });

    it('never throws when the hook rejects — a dead service must not break the switch', async () => {
        const activation = createWorkspaceActivation({
            lifecycle: () =>
                ({
                    onWorkspaceOpen: async () => {
                        throw new Error('docker is on fire');
                    },
                }) as unknown as DevServerLifecycle,
        });

        expect(() => activation.activated(WS.id)).not.toThrow();
        await expect(activation.idle()).resolves.toBeUndefined();
    });

    it('never throws when the hook throws SYNCHRONOUSLY either', async () => {
        const activation = createWorkspaceActivation({
            lifecycle: () =>
                ({
                    onWorkspaceOpen: () => {
                        throw new Error('nope');
                    },
                }) as unknown as DevServerLifecycle,
        });

        expect(() => activation.activated(WS.id)).not.toThrow();
        await activation.idle();
    });

    it('is a no-op with no dev-server lifecycle, and for an empty id', async () => {
        const activation = createWorkspaceActivation({ lifecycle: () => null });
        expect(() => activation.activated(WS.id)).not.toThrow();

        const { calls, lifecycle } = deferredLifecycle();
        const live = createWorkspaceActivation({ lifecycle: () => lifecycle });
        live.activated('');
        live.activated(null);
        live.activated(undefined);
        expect(calls).toEqual([]);
    });

    it('routes the process-wide door through the live lifecycle', async () => {
        const services = fakeServices();
        realLifecycleOver(services.manager);

        workspaceActivated(WS.id);
        await workspaceActivationIdleForTests();

        expect(services.acquired).toEqual([WS.id]);
    });
});

describe('the boot wiring', () => {
    // A source guard, not a behaviour test: `main/background.ts` pulls in the
    // whole Electron app graph and cannot be imported here. What it protects is
    // the pair of calls that make the two doors above reachable at all — the
    // write hook, and the launch restore that has no write to hook.
    const source = fs.readFileSync(
        path.resolve(__dirname, '..', '..', 'background.ts'),
        'utf8',
    );

    // `includes(...)` rather than `toContain`, so a failure reports a boolean
    // instead of dumping ~4k lines of background.ts into the run.
    it('installs the active-workspace write hook', () => {
        expect(source.includes('watchActiveWorkspace();')).toBe(true);
    });

    it('takes the launch restore after boot adoption', () => {
        expect(source.includes('activateRestoredWorkspace();')).toBe(true);
    });
});
