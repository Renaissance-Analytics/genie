import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    addWorkspace,
    createTerminalSpec,
    deleteTerminalSpec,
    getAllSettings,
    getWorkspace,
    removeWorkspace,
    setSettings,
    setWorkspaceGappDev,
} from '../db';
import { getTerminalSize } from '../terminal/size-tracker';
import { killTerminalById, announceInboxIncoming } from '../terminal/ipc';
import { liveHostTerminals } from '../terminal/quit-confirm';

/**
 * Deterministic fixture for the MASTER WINDOW E2E spec (e2e/master-window.spec.ts,
 * genie#228).
 *
 * The window this seeds for is not a harness page: `showE2EWindow` loads
 * `master.html`, so the spec drives the REAL `renderer/pages/master.tsx` — the
 * app's actual main window, which had no end-to-end coverage at all. Everything
 * from the workspace rail to the floor to the status bar is the shipped code
 * reading the shipped database; the only thing standing in for production is the
 * sign-in read (see `isE2EMaster` in ./mock.ts), because the throwaway E2E
 * profile has no session and the page returns early to `SignInPrompt` without one.
 *
 * WHAT IT SEEDS, AND WHY EACH PART IS NEEDED:
 *   - TWO workspaces, so the rail has a row to list AND the spec has somewhere to
 *     switch to. The switch is the point: off-workspace panels stay mounted-hidden
 *     to keep their ptys alive, which is the condition genie#229 came out of.
 *   - ONE terminal spec in each, so the floor has a panel to lay out and the
 *     status bar has something to count. A real spec, on a real directory, driven
 *     by the real pty — a panel with no terminal in it would prove nothing about
 *     the window that hosts terminals.
 *   - `active_workspace`, so the launch restore targets THIS fixture rather than
 *     whichever workspace another spec's seed happened to leave behind.
 *
 * IDEMPOTENT AND RESETTING, deliberately — the same reason `seedAgentAccessE2E`
 * is. `launchGenieE2E` reuses one throwaway profile across runs, so anything the
 * last run's spec (or the page itself) persisted is still here: a saved panel
 * layout, a different active workspace, a spec row from an older fixture shape.
 * Left alone, those make a seed that passes once and then quietly asserts against
 * the leftovers instead of against the fixture.
 */

/** Fixed ids so a re-run REPLACES the fixture instead of piling up beside it. */
const WORKSPACE_ID = 'e2e-master-window';
const WORKSPACE_NAME = 'Master Window E2E';
const PEER_ID = 'e2e-master-window-peer';
const PEER_NAME = 'Master Peer E2E';
const TERMINAL_ID = 'e2e-master-terminal';
const TERMINAL_LABEL = 'master-floor';
const PEER_TERMINAL_ID = 'e2e-master-peer-terminal';
const PEER_TERMINAL_LABEL = 'peer-floor';
/** The Tynn project the GDW fixture is linked to — see the note in `seedMasterE2E`. */
const PEER_TYNN_PROJECT_ID = 'e2e-master-peer-tynn-project';

export interface MasterSeed {
    workspaceId: string;
    workspaceName: string;
    terminalId: string;
    terminalLabel: string;
    peerId: string;
    peerName: string;
    /**
     * The GDW's folder on disk. Published because the GApp Store's dev-launcher
     * entry NAMES it — that line is what settles which row is which when an
     * install and a launcher carry the same app name — and it is a temp path the
     * spec cannot know ahead of time.
     */
    peerPath: string;
    peerTerminalId: string;
    peerTerminalLabel: string;
}

/**
 * PURE. The `view_state_json` store minus every entry belonging to the given
 * workspaces, for any window (`connKey`).
 *
 * The master page persists each window's panel layout under
 * `${connKey}|${workspaceId}`, and that store WINS on launch: when an entry
 * exists for the target workspace, `computeLaunchSelection` restores exactly its
 * `visibleIds` and never falls back to the workspace's enabled specs. So a run
 * that hid a panel — or simply ran before these fixed ids existed — hands the
 * next run an empty floor while every seeded row sits in the database.
 *
 * Only the named workspaces are dropped. The blob is ONE setting shared by every
 * window and every other fixture in the profile; a seed that cleared it wholesale
 * would be reaching into layouts it does not own.
 */
export function pruneFixtureViews(
    json: string | null | undefined,
    workspaceIds: string[],
): Record<string, unknown> {
    if (!json) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const owned = new Set(workspaceIds);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        // `${connKey}|${workspaceId}` — split on the FIRST separator only, so the
        // workspace id is matched WHOLE. A prefix test would take
        // `…-window-peer` along with `…-window`.
        const sep = key.indexOf('|');
        const workspaceId = sep === -1 ? key : key.slice(sep + 1);
        if (owned.has(workspaceId)) continue;
        out[key] = value;
    }
    return out;
}

/** A real directory on disk — the pty spawns with this as its cwd. */
function workspaceDir(id: string): string {
    const dir = path.join(os.tmpdir(), 'genie-e2e-master', id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function seedWorkspace(id: string, name: string, order: number): string {
    const dir = workspaceDir(id);
    // Replace rather than update: a fixture whose SHAPE changed between runs (a
    // renamed workspace, a moved path) must not survive as a half-old row.
    if (getWorkspace(id)) removeWorkspace(id);
    addWorkspace({
        id,
        backend: 'aionima',
        project_id: id,
        project_name: name,
        tynn_project_id: id,
        tynn_project_name: name,
        // 'simple', not 'agi': an .agi workspace draws an AgiHealth probe into the
        // rail row, and this fixture has no envelope for it to read.
        shape: 'simple',
        path: dir,
        editor: null,
        editor_cmd: null,
        start_cmd: null,
        env_file: null,
        last_opened_at: null,
        created_by_genie: 0,
        sort_order: order,
    });
    return dir;
}

/**
 * Seed the two fixture workspaces, a terminal in each, and the launch state that
 * decides which of them the window opens on. Publishes the ids — and a way to read
 * the pty geometry back — on a global the spec reaches through `helpers/launch.ts`.
 */
export function seedMasterE2E(): MasterSeed {
    // Specs FIRST: `terminal_specs.workspace_id` is ON DELETE SET NULL, so
    // dropping a workspace ORPHANS its specs rather than removing them — and an
    // orphan without `meta.system` belongs to no workspace at all, so it would
    // accumulate invisibly in the profile, one per run.
    deleteTerminalSpec(TERMINAL_ID);
    deleteTerminalSpec(PEER_TERMINAL_ID);

    const dir = seedWorkspace(WORKSPACE_ID, WORKSPACE_NAME, 0);
    const peerDir = seedWorkspace(PEER_ID, PEER_NAME, 1);

    // The PEER is the GApp Development Workspace fixture (genie#245); the first
    // workspace stays ordinary, so the spec has a control to compare against in
    // the same rail — "the GDW has the class" proves nothing on its own if every
    // row has it.
    //
    // The project.json link is not decoration. `pickTynnLink` resolves a link from
    // the workspace ROW only when its backend is 'tynn', and this fixture is
    // 'aionima' so nothing here reaches out to a backend. A `tynn` block on disk
    // resolves regardless of backend, which gives the row a link WITHOUT a
    // network. That matters because the master window now nudges the project list
    // on focus: with no link at all, the sync would read "unlinked" and clear the
    // flag mid-spec. With one, the project is merely ABSENT from the (empty) E2E
    // project list, which `planGappDevSync` deliberately leaves alone.
    fs.writeFileSync(
        path.join(peerDir, 'project.json'),
        JSON.stringify({ name: PEER_NAME, tynn: { projectId: PEER_TYNN_PROJECT_ID } }, null, 2),
    );
    setWorkspaceGappDev(PEER_ID, true);
    setWorkspaceGappDev(WORKSPACE_ID, false);

    createTerminalSpec({
        id: TERMINAL_ID,
        workspace_id: WORKSPACE_ID,
        label: TERMINAL_LABEL,
        cwd: dir,
        type: 'terminal',
    });
    createTerminalSpec({
        id: PEER_TERMINAL_ID,
        workspace_id: PEER_ID,
        label: PEER_TERMINAL_LABEL,
        cwd: peerDir,
        type: 'terminal',
    });

    setSettings({
        // The launch restore prefers the persisted active workspace over the
        // most-recent row, so pinning it here makes the opening floor the
        // fixture's whatever else the profile holds.
        active_workspace: WORKSPACE_ID,
        view_state_json: JSON.stringify(
            pruneFixtureViews(getAllSettings().view_state_json, [WORKSPACE_ID, PEER_ID]),
        ),
    });

    const seed: MasterSeed = {
        workspaceId: WORKSPACE_ID,
        workspaceName: WORKSPACE_NAME,
        terminalId: TERMINAL_ID,
        terminalLabel: TERMINAL_LABEL,
        peerId: PEER_ID,
        peerName: PEER_NAME,
        peerPath: peerDir,
        peerTerminalId: PEER_TERMINAL_ID,
        peerTerminalLabel: PEER_TERMINAL_LABEL,
    };
    (globalThis as Record<string, unknown>).__GENIE_E2E_MASTER__ = {
        seed,
        /**
         * The grid last APPLIED to a terminal's pty (main/terminal/size-tracker).
         * This is the half of genie#229 the DOM cannot show: a panel fitted while
         * hidden looks perfectly normal once it comes back — the damage is the
         * geometry that reached the pty while the panel was off screen, and the
         * scrollback the TUI reflowed to it.
         */
        ptyGrid: (id: string) => getTerminalSize(id),
        /**
         * The ids main currently has a LIVE pty for. Read alongside `ptyGrid` so a
         * missing grid says WHICH half failed: no live pty means the spawn never
         * happened (or died); a live pty with no grid means the resize did.
         */
        liveTerminals: (): string[] => liveHostTerminals().map((t) => t.id),
        /**
         * Kill the fixture's ptys. The spec calls this BEFORE closing the app: a
         * manual quit with a live terminal and a window open raises the
         * keep-or-shut-down confirmation IN THIS WINDOW (it is the real master
         * page, so it really renders that modal) and quit then waits 30s for an
         * answer nobody is there to give.
         */
        killTerminals: () => {
            killTerminalById(TERMINAL_ID);
            killTerminalById(PEER_TERMINAL_ID);
        },
        /**
         * Raise the AgentInbox "a message came in" toast for a terminal, through
         * the REAL announce path — same fact lookup, same notice, same broadcast
         * a delivered nudge uses. Only the pty write that precedes it is skipped,
         * because the thing under test is what the renderer does with the payload.
         *
         * That payload is exactly what the bug was: it used to be `{ id }` and the
         * page discarded it, drawing a fixed sentence about "this agent" — which
         * a reader can only take to mean the terminal in front of them, while the
         * notice had gone to the addressee in another workspace.
         */
        announceInboxIncoming: (id: string, landed: boolean) =>
            announceInboxIncoming(id, landed),
    };
    return seed;
}
