import fs from 'node:fs';
import path from 'node:path';

const RESET_MARKER = '.reset-workstation';

/**
 * Entries a workstation reset must NOT delete.
 *
 * `toolchain` is policy: Genie's managed language runtimes belong to the user,
 * not to Genie's local state, and re-downloading them costs hours.
 *
 * `runtime` and `pty-host` are there for a harder reason. Both are
 * content-keyed caches Genie materialises from files shipped inside the app
 * bundle (`ensureStandaloneRuntime` / the pty-host payload in
 * `terminal/host-service.ts`), and both hold RUNNING EXECUTABLES —
 * `runtime/<key>/node.exe`, `pty-host/<key>/node_modules/node-pty/.../OpenConsole.exe`.
 * Windows refuses to remove a directory containing a loaded image: `fs.rmSync`
 * throws EBUSY/EPERM, and `force: true` does not help, because it suppresses
 * "missing", not "in use".
 *
 * Nothing this process can do makes that safe. The detached pty-host is
 * DESIGNED to outlive Genie's quit (so terminals survive an update), and an
 * OS-service host outlives it by definition — so the process applying the reset
 * is racing the *previous* process's children, not its own. Deleting these
 * therefore fails on exactly the machines the feature has to work on, and buys
 * nothing: they carry no user state and are re-derived on the next launch.
 * (genie#349)
 */
const PRESERVED_ENTRIES = new Set(['toolchain', 'runtime', 'pty-host']);

/** One userData entry a reset could not remove. */
export interface ResetFailure {
    /** The entry name (`pty-host`), not a full path — this is shown to the user. */
    entry: string;
    message: string;
}

export interface WorkstationResetOutcome {
    applied: boolean;
    preserved: string[];
    /**
     * Empty on a clean reset. Non-empty means the reset was PARTIAL: some state
     * the user asked to be removed is still there, and it will NOT be retried.
     * The caller has to say so — see `applyWorkstationResetAtBoot`.
     */
    failures: ResetFailure[];
}

/**
 * The filesystem operations a reset performs, as a port.
 *
 * Injectable because the failure that bricks installs — a directory holding a
 * running `.exe`, which Windows refuses to delete — cannot be produced honestly
 * on disk from a test: there is no portable way to lock a directory, and a test
 * that managed it would be testing the OS. Production always gets `nodeResetFs`.
 */
export interface ResetFs {
    exists(target: string): boolean;
    list(dir: string): string[];
    remove(target: string): void;
}

export const nodeResetFs: ResetFs = {
    exists: (target) => fs.existsSync(target),
    list: (dir) => fs.readdirSync(dir),
    remove: (target) => fs.rmSync(target, { recursive: true, force: true }),
};

function reason(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export function isWorkstationResetPending(
    userDataDir: string,
    io: ResetFs = nodeResetFs,
): boolean {
    return io.exists(path.join(userDataDir, RESET_MARKER));
}

export function requestWorkstationReset(userDataDir: string): void {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, RESET_MARKER), new Date().toISOString(), {
        encoding: 'utf8',
        mode: 0o600,
    });
}

/**
 * Apply a pending reset: remove Genie's local state, keep `PRESERVED_ENTRIES`.
 *
 * Reports what it could not remove instead of stopping at the first refusal.
 * See `applyWorkstationResetAtBoot` for the entry point boot should use.
 */
export function applyPendingWorkstationReset(
    userDataDir: string,
    io: ResetFs = nodeResetFs,
): WorkstationResetOutcome {
    const marker = path.join(userDataDir, RESET_MARKER);
    if (!isWorkstationResetPending(userDataDir, io)) {
        return { applied: false, preserved: [], failures: [] };
    }
    const preserved = [...PRESERVED_ENTRIES];

    // THE MARKER GOES FIRST, before anything is deleted.
    //
    // It used to be cleared after the loop, which made a single failure
    // permanent: one locked directory threw, the marker survived, and every
    // later boot ran the same reset into the same lock — a brick a reinstall
    // cannot clear, because uninstalling Genie leaves userData behind. A reset
    // that cannot finish must fail ONCE. (genie#349)
    try {
        io.remove(marker);
    } catch (e) {
        // The one failure that must stop everything else. Clearing state we
        // cannot record as done would re-run the reset on the next boot, and
        // the boot after that — destroying the fresh database each time. Leave
        // userData alone and report it.
        return {
            applied: false,
            preserved: [],
            failures: [{ entry: RESET_MARKER, message: reason(e) }],
        };
    }

    let entries: string[];
    try {
        entries = io.list(userDataDir);
    } catch (e) {
        return { applied: true, preserved, failures: [{ entry: '.', message: reason(e) }] };
    }

    const failures: ResetFailure[] = [];
    for (const name of entries) {
        if (name === RESET_MARKER || PRESERVED_ENTRIES.has(name)) continue;
        // Per entry: one locked directory must not abandon the other twenty.
        try {
            io.remove(path.join(userDataDir, name));
        } catch (e) {
            failures.push({ entry: name, message: reason(e) });
        }
    }
    return { applied: true, preserved, failures };
}

/**
 * The entry point BOOT uses: apply a pending reset without being able to take
 * the boot down with it.
 *
 * `background.ts` runs this before `initDatabase`, which is the right place —
 * nothing in THIS process has opened userData yet. What the old call could not
 * survive was a throw: it ran unguarded, so an EBUSY from a locked directory
 * aborted `app.whenReady` before the database, the IPC handlers and the tray
 * existed. Genie stayed alive (the process-level `unhandledRejection` guard
 * catches it) but half-booted and windowless — which is what the user saw as a
 * sign-in screen on a black background that a reinstall did not fix.
 *
 * Never throws. Calls `report` exactly once, and only when something actually
 * failed: a partial reset is a real failure and must reach the user rather than
 * merely be survived.
 */
export function applyWorkstationResetAtBoot(
    userDataDir: string,
    report: (failures: ResetFailure[]) => void,
    io: ResetFs = nodeResetFs,
): WorkstationResetOutcome {
    let outcome: WorkstationResetOutcome;
    try {
        outcome = applyPendingWorkstationReset(userDataDir, io);
    } catch (e) {
        // `applyPendingWorkstationReset` guards every filesystem call it makes,
        // so reaching here means a defect in it rather than a locked file. Boot
        // still must not die for it, and the user still must be told.
        outcome = {
            applied: false,
            preserved: [],
            failures: [{ entry: '.', message: reason(e) }],
        };
    }
    if (outcome.failures.length > 0) {
        try {
            report(outcome.failures);
        } catch (e) {
            // The reporter is the user-facing path; if it fails there is nowhere
            // left to say so, but it must not become the thing that stops boot.
            // eslint-disable-next-line no-console
            console.error('[workstation reset] could not report the failure:', e);
        }
    }
    return outcome;
}
