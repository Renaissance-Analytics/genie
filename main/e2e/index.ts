import path from 'node:path';
import { BrowserWindow } from 'electron';
// TYPE-only, so it erases at compile time and creates no runtime edge back into the
// product -- a value import from `../terminal/*` would re-anchor this whole tree into the
// shipped bundle, which is the one thing this module exists to prevent.
import type { RecoveryState } from '../terminal/recovery-channels';
import { isE2E, isE2EMobile, isE2ETunnel } from './flags';
import { registerE2EMocks, startMobileE2EServer } from './mock';
import { startTunnelE2EHarness } from './tunnel';
import { registerAppsE2E } from './apps';
import { seedAgentAccessE2E } from './agent-access';
import { seedAgentManagerE2E } from './agent-manager';
import { seedAgentPulseE2E } from './agent-pulse';
import { registerAgentRevivalE2E } from './agent-revival';
import { raiseAskE2E, seedAskE2E } from './ask';
import { seedFlowsE2E } from './flows';
import { listWorkspaces, removeWorkspace } from '../db';
import { seedMasterE2E } from './master';
import { seedRepoE2E } from './repo';
import { seedTynnImportE2E } from './tynn-import';
import { seedWorkspaceCreateE2E } from './workspace-create';

/**
 * THE ONLY DOOR INTO THE E2E RIG.
 *
 * Every module this file imports is Playwright rigging: `registerE2EMocks` replaces GitHub
 * IPC with fixtures, `hosting.ts` fakes a hosting backend, and the seeds write fixture
 * workspaces, agents and repos into the real database.
 *
 * It exists because `main/background.ts` used to import all of that STATICALLY, at thirteen
 * import sites. Dead call sites are not enough to get it out of the bundle — measured: with
 * every `isE2E()` folded to `false`, rolldown still kept 19 `main/e2e/` files in
 * `app/background.js`, because a static import is retained unless the module can be proven
 * side-effect-free. A bundler keeps what it is told to keep.
 *
 * So background.ts reaches the rig through `await import('./e2e')` inside a branch guarded
 * by the compile-time `E2E_BUILD`. The branch folds away in a production build, nothing
 * references this module, and the whole tree goes with it. Measured the same way, by
 * `scripts/assert-no-e2e-in-bundle.mjs`, against the artifact rather than the intent.
 *
 * ## Why a host object
 *
 * `showE2EWindow` needs the preload path, the dev-server origin, the themed background
 * colour, the ForceTheQuestion IPC registration and the terminal-recovery broadcast
 * channels — all owned by background.ts. Injecting them keeps the arrow pointing one way:
 * the product knows nothing about the rig, and the rig cannot import the product. A single
 * `import` back into `background.ts` would re-anchor this tree into the bundle and undo
 * the whole exercise.
 */
export interface E2EHost {
    /** Dev builds load pages from the Vite dev server instead of `file://`. */
    isDev: boolean;
    /** Directory the running `background.js` is in — where `<page>.html` and `preload.js` live. */
    appDir: string;
    /** e.g. `http://localhost:8888`. Injected rather than hard-coded so the port has one home. */
    devServerOrigin: string;
    /** Resolved window background, so a harness window does not flash the wrong theme. */
    backgroundColor: string;
    /**
     * Registers the ForceTheQuestion IPC EARLY.
     *
     * Pre-bound by background.ts, which owns the config. `createAskWindow` refuses to open
     * until this is registered, so a question raised beforehand would be deferred to the
     * inbox and no modal would ever exist for Playwright to attach to.
     */
    registerForceQuestionIpc: () => void;
    /** The real `broadcastToWindows`, so specs drive the SAME emit path the product uses. */
    broadcast: (channel: string, payload: unknown) => void;
    /** Channel names, from the product's own constants — a drift here must fail a spec. */
    recoveryChannels: { status: string; recover: string };
}

function showE2EWindow(host: E2EHost): void {
    // Allowlist the harness routes so a stray env value can't load an arbitrary
    // page; default to the issue-watch harness for back-compat.
    const requested = process.env.GENIE_E2E_PAGE ?? 'e2e-issuewatch';
    const ALLOWED = [
        'e2e-ghcaps',
        // Not a harness page either — see the `ask` branch below.
        'ask',
        'e2e-issuewatch',
        'e2e-agent-access',
        'e2e-agent-manager',
        'e2e-picker-layer',
        'e2e-hosting',
        'e2e-repo-panel',
        'e2e-terminal-recovery',
        'e2e-tynn-health',
        'e2e-tynn-import',
        'e2e-workspace-create',
        'e2e-agent-pulse',
        'e2e-deck',
        'e2e-agent-view',
        'e2e-dashboard',
        'e2e-stream',
        // The product page, not a harness (genie#228). See the doc comment.
        'master',
    ] as const;
    /**
     * An UNKNOWN page that was explicitly asked for is a MISTAKE, and must not be
     * substituted quietly.
     *
     * This used to fall back to `e2e-issuewatch` for any unrecognised value. A new harness
     * added to `e2e/helpers/launch.ts` but not to this second list therefore ran its specs
     * against a DIFFERENT page, and every assertion failed as "element not found" -- which
     * points at the component under test rather than at this allowlist. Cost a full CI
     * round trip to find.
     *
     * The default (nothing requested) still falls back, because that is back-compat rather
     * than a mistake.
     */
    if (process.env.GENIE_E2E_PAGE && !(ALLOWED as readonly string[]).includes(requested)) {
        throw new Error(
            `GENIE_E2E_PAGE="${requested}" is not in showE2EWindow's ALLOWED list. ` +
                'Add it there as well as to HARNESS_ROUTE in e2e/helpers/launch.ts — otherwise ' +
                'the specs silently run against a different page.',
        );
    }
    const page = (ALLOWED as readonly string[]).includes(requested) ? requested : 'e2e-issuewatch';
    if (page === 'e2e-agent-access') {
        // Seed the fixture workspaces BEFORE the window loads — the harness page
        // resolves its target by listing on mount, so the rows must already exist.
        // Also resets agent_access, since the E2E profile is reused across runs.
        try {
            seedAgentAccessE2E();
        } catch (e) {
            console.error('[e2e] agent-access seed failed', e);
        }
    }
    if (page === 'e2e-agent-manager') {
        // Seed the workspace, its REAL AGENT.md and .mcp.json, and the agent +
        // sidecar rows BEFORE the window loads — the harness page resolves its
        // target by listing on mount. Re-seeded every run because the spec's own
        // saves rewrite the file, and a leftover one would make the round-trip
        // assertion pass against a value it did not write.
        try {
            seedAgentManagerE2E();
        } catch (e) {
            console.error('[e2e] agent-manager seed failed', e);
        }
    }
    if (page === 'e2e-repo-panel') {
        // Seed the fixture git repo + workspace BEFORE the window loads; the
        // harness page discovers it via workspaces.list() on mount.
        try {
            seedRepoE2E();
        } catch (e) {
            console.error('[e2e] repo-panel seed failed', e);
        }
    }
    if (page === 'e2e-agent-pulse') {
        // Seed the fixture workspace BEFORE the window loads — the harness page
        // resolves its row by listing on mount — and expose the pulse emitter so
        // the spec can push activity on the REAL `agent-pulse` channel.
        try {
            seedAgentPulseE2E();
        } catch (e) {
            console.error('[e2e] agent-pulse seed failed', e);
        }
    }
    if (page === 'e2e-workspace-create') {
        // Empty the destination folder, drop any workspace a previous run left
        // in it, and pre-set the primary workspace folder BEFORE the window
        // loads — the form reads it on mount as the default location (genie#431).
        try {
            seedWorkspaceCreateE2E();
        } catch (e) {
            console.error('[e2e] workspace-create seed failed', e);
        }
    }
    if (page === 'e2e-tynn-import') {
        // Clear any workspace a previous run registered and pre-set the primary
        // workspace folder BEFORE the window loads — the modal reads it on mount
        // as the default clone destination (genie#355).
        try {
            seedTynnImportE2E();
        } catch (e) {
            console.error('[e2e] tynn-import seed failed', e);
        }
    }
    if (page === 'master') {
        /**
         * AN EMPTY WORKSTATION, for the FIRST-RUN spec.
         *
         * `GENIE_E2E_EMPTY_WORKSTATION` skips the seed and clears whatever the reused profile has,
         * because first run is defined by `workspaces.length === 0` and the master seed's whole job
         * is to make that false. Without it the one state the flow exists for is unreachable in a
         * real window — which is how that component went its whole life with no mount site and
         * nobody noticed.
         *
         * Deliberately a SKIP rather than a second harness page: the spec needs the real master
         * route, the real boot path and the real first-run gate. A separate page would test a
         * different window.
         */
        if (process.env.GENIE_E2E_EMPTY_WORKSTATION) {
            // ONE TRY PER ROW, not one around the loop. `removeWorkspaceIn` THROWS by design for
            // the System Workspace — *"the workstation operator's own workspace and cannot be
            // unregistered"* — and a `try` around the whole loop means the first such throw leaves
            // every remaining workspace in place. `listWorkspaces()` excludes that row today, so
            // this is latent rather than live; it costs a line, and the failure it prevents is a
            // whole VM run spent on a first-run spec testing a seeded workstation.
            for (const ws of listWorkspaces()) {
                try {
                    removeWorkspace(ws.id);
                } catch (e) {
                    console.error(`[e2e] clearing workspace ${ws.id} failed`, e);
                }
            }
        } else {
            // Seed the fixture workspaces + terminals BEFORE the window loads: the
            // real page lists them on mount and restores its launch grid from what it
            // finds, so a row that arrives afterwards is a row the floor never lays
            // out. Also resets the persisted layout + active workspace, since the E2E
            // profile is reused across runs.
            try {
                seedMasterE2E();
            } catch (e) {
                console.error('[e2e] master seed failed', e);
            }
        }
        // Flows for the manager flyout the master header opens, plus the emitter
        // the spec drives the header animation with. Separate from the master
        // seed because it touches a different table and a failure in one must
        // not take the other's rows with it.
        try {
            seedFlowsE2E();
        } catch (e) {
            console.error('[e2e] flows seed failed', e);
        }
    }
    if (page === 'e2e-terminal-recovery') {
        // Let the spec drive the host-loss watchdog's OWN emit path (genie#203):
        // the SAME broadcastToWindows + channel constants genie-adapter uses, so a
        // channel-string drift between emit (genie-adapter) and listen (preload)
        // surfaces as a failing E2E rather than a silent dead path.
        (globalThis as Record<string, unknown>).__GENIE_E2E_RECOVERY__ = {
            emitStatus: (state: RecoveryState) =>
                host.broadcast(host.recoveryChannels.status, { state }),
            reattach: (ids: string[]) => host.broadcast(host.recoveryChannels.recover, { ids }),
        };
    }
    if (page === 'ask') {
        // NOT a harness page, and not a page load either: the ForceTheQuestion
        // modal is a window the PRODUCT opens, so the fixture raises real
        // questions and `createAskWindow` makes the window Playwright attaches
        // to. Opening a harness window here as well would hand the spec the
        // wrong `firstWindow`.
        try {
            host.registerForceQuestionIpc();
            seedAskE2E();
            raiseAskE2E();
        } catch (e) {
            console.error('[e2e] ask seed failed', e);
        }
        return;
    }
    const win = new BrowserWindow({
        width: 900,
        height: 760,
        show: true,
        title: 'Genie E2E',
        backgroundColor: host.backgroundColor,
        webPreferences: {
            preload: path.join(host.appDir, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    /**
     * `GENIE_E2E_VIEW` lets a spec ask for a specific surface.
     *
     * The DEFAULT is deliberately left alone, so the E2E harness opens whatever the product
     * opens -- if the default surface ever fails to render, a spec catches it. Specs that are
     * about the PANEL GRID ask for it by name (`view=grid`) rather than relying on it being
     * the default, which it no longer is.
     */
    const e2eView = process.env.GENIE_E2E_VIEW?.trim();
    const viewQuery = e2eView ? `?view=${encodeURIComponent(e2eView)}` : '';
    if (host.isDev) {
        win.loadURL(`${host.devServerOrigin}/${page}${viewQuery}`);
    } else {
        win.loadFile(
            path.join(host.appDir, `${page}.html`),
            viewQuery ? { search: viewQuery.slice(1) } : {},
        );
    }
}


/**
 * Boot-time rig: mock the backends, open the window the spec attaches to, and bring up the
 * mobile server when that is what is being driven.
 *
 * Called where `if (isE2E())` used to inline all three, and in the same order — the mocks
 * must be registered before the window loads, because the harness page resolves its target
 * by listing on mount.
 */
export async function startE2EAtBoot(host: E2EHost): Promise<void> {
    if (!isE2E()) return;
    registerE2EMocks();
    // eslint-disable-next-line no-console
    console.log('[e2e] GENIE_E2E=1 — GitHub + Issue Watch IPC mocked.');
    // NOW, not at the end of whenReady: the later startup steps (terminal backend
    // selection, MCP/control servers) touch native modules that may be unbuildable in a
    // test sandbox, and if one of those awaits hangs or throws, a window opened afterwards
    // would never appear. The window only needs IPC + the renderer, both ready by here.
    showE2EWindow(host);
    if (isE2EMobile()) {
        // The REAL mobile server on 127.0.0.1 at a fixed port/PIN with mock data deps. The
        // desktop window above is irrelevant for that spec — the served `/m/` page, REST
        // and WS are what it drives.
        await startMobileE2EServer().catch((e) =>
            // eslint-disable-next-line no-console
            console.error('[e2e] mobile server failed to start', e),
        );
    }
}

/** The tunnel rung, when a spec asks for it (GENIE_E2E_TUNNEL=1). */
export async function startE2ETunnel(): Promise<void> {
    if (!isE2ETunnel()) return;
    await startTunnelE2EHarness().catch((e) =>
        // eslint-disable-next-line no-console
        console.error('[e2e] tunnel harness failed to start', e),
    );
}

/**
 * The GApp-window fixture, registered over the REAL bridge.
 *
 * The property it proves is a NEGATIVE — `window.genie` is absent inside a GApp's page —
 * and a negative cannot be established by reading code.
 */
export function registerE2EApps(): void {
    if (!isE2E()) return;
    registerAppsE2E();
}

/** The agent-revival fixture (genie#346 server push). */
export function registerE2EAgentRevival(): void {
    if (!isE2E()) return;
    registerAgentRevivalE2E();
}
