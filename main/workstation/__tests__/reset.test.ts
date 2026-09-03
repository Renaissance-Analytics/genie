import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    applyPendingWorkstationReset,
    applyWorkstationResetAtBoot,
    isWorkstationResetPending,
    requestWorkstationReset,
    type ResetFailure,
    type ResetFs,
} from '../reset';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-reset-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'toolchain', 'node', '22'), { recursive: true });
    fs.writeFileSync(path.join(root, 'toolchain', 'node', '22', 'node.exe'), 'owned tool');
    // The two caches that hold RUNNING executables on Windows: the standalone
    // Node the pty-host runs on, and the materialised host payload with
    // node-pty's OpenConsole.exe inside it. Both are re-derived from the app
    // bundle on demand; neither is user state.
    fs.mkdirSync(path.join(root, 'runtime', '20.20.2-win32-x64'), { recursive: true });
    fs.writeFileSync(path.join(root, 'runtime', '20.20.2-win32-x64', 'node.exe'), 'running');
    fs.mkdirSync(path.join(root, 'pty-host', 'fth0.3.1-npty1.1.0'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'pty-host', 'fth0.3.1-npty1.1.0', 'OpenConsole.exe'),
        'running',
    );
    fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(root, 'plugins', 'installed.json'), '{}');
    fs.mkdirSync(path.join(root, 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Cache', 'blob'), 'x');
    fs.writeFileSync(path.join(root, 'genie.db'), 'state');
    fs.writeFileSync(path.join(root, 'Preferences'), '{}');
    return root;
}

/**
 * A `ResetFs` that behaves exactly like the real one except that `remove`
 * refuses the named entries with the EBUSY Windows raises for a directory
 * holding a loaded image. Every deletion it does NOT refuse really happens on
 * disk, so the "was actually removed" assertions below are against the
 * filesystem rather than against the fake.
 */
function lockedFs(locked: string[]): ResetFs & { removed: string[] } {
    const removed: string[] = [];
    return {
        removed,
        exists: (target) => fs.existsSync(target),
        list: (dir) => fs.readdirSync(dir),
        remove: (target) => {
            const name = path.basename(target);
            removed.push(name);
            if (locked.includes(name)) {
                throw Object.assign(
                    new Error(`EBUSY: resource busy or locked, rmdir '${target}'`),
                    { code: 'EBUSY' },
                );
            }
            fs.rmSync(target, { recursive: true, force: true });
        },
    };
}

describe('workstation reset boundary', () => {
    it('defers the destructive reset until the clean restart boundary', () => {
        const root = fixture();

        requestWorkstationReset(root);

        expect(fs.existsSync(path.join(root, 'genie.db'))).toBe(true);
        expect(fs.existsSync(path.join(root, '.reset-workstation'))).toBe(true);
        expect(isWorkstationResetPending(root)).toBe(true);
    });

    it('removes Genie workstation state while preserving the entire managed toolchain', () => {
        const root = fixture();
        requestWorkstationReset(root);

        expect(applyPendingWorkstationReset(root)).toEqual({
            applied: true,
            preserved: ['toolchain', 'runtime', 'pty-host'],
            failures: [],
        });
        expect(fs.readFileSync(path.join(root, 'toolchain', 'node', '22', 'node.exe'), 'utf8')).toBe(
            'owned tool',
        );
        expect(fs.existsSync(path.join(root, 'genie.db'))).toBe(false);
        expect(fs.existsSync(path.join(root, 'plugins'))).toBe(false);
        expect(fs.existsSync(path.join(root, '.reset-workstation'))).toBe(false);
    });

    it('does nothing without an explicit pending-reset marker', () => {
        const root = fixture();
        expect(applyPendingWorkstationReset(root)).toEqual({
            applied: false,
            preserved: [],
            failures: [],
        });
        expect(fs.existsSync(path.join(root, 'genie.db'))).toBe(true);
    });
});

/**
 * genie#349 — a reset that could not finish bricked the install permanently.
 *
 * `runtime/` and `pty-host/` hold running executables, and the detached
 * pty-host is DESIGNED to outlive Genie's quit, so the booting process meets
 * locked directories no matter how early it runs. `fs.rmSync` threw EBUSY, the
 * throw escaped, and because the marker was cleared only AFTER the loop, every
 * subsequent boot repeated the same crash — before `initDatabase`, so Genie
 * came up windowless with no IPC. Uninstalling did not help: userData survives
 * an uninstall, and the marker lives in userData.
 */
describe('a reset that cannot finish must fail ONCE (genie#349)', () => {
    it('clears the marker BEFORE deleting anything, so a locked entry cannot re-arm it', () => {
        const root = fixture();
        requestWorkstationReset(root);
        const io = lockedFs(['plugins']);

        const outcome = applyPendingWorkstationReset(root, io);

        // The marker is the first thing removed — nothing that can throw runs
        // ahead of it.
        expect(io.removed[0]).toBe('.reset-workstation');
        expect(fs.existsSync(path.join(root, '.reset-workstation'))).toBe(false);
        expect(isWorkstationResetPending(root)).toBe(false);
        // POSITIVE CONTROL: "the marker is gone" passes just as well against a
        // reset that did nothing at all, so prove this one really deleted state.
        expect(fs.existsSync(path.join(root, 'genie.db'))).toBe(false);
        expect(outcome.applied).toBe(true);
    });

    it('does not abandon the other entries when one is locked', () => {
        const root = fixture();
        requestWorkstationReset(root);

        const outcome = applyPendingWorkstationReset(root, lockedFs(['plugins']));

        // The locked one survives; every other entry is cleared regardless of
        // where it sat in the listing relative to the failure.
        expect(fs.existsSync(path.join(root, 'plugins'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'genie.db'))).toBe(false);
        expect(fs.existsSync(path.join(root, 'Cache'))).toBe(false);
        expect(fs.existsSync(path.join(root, 'Preferences'))).toBe(false);
        expect(outcome.failures.map((f) => f.entry)).toEqual(['plugins']);
        expect(outcome.failures[0].message).toContain('EBUSY');
    });

    it('never attempts the directories that hold running executables', () => {
        const root = fixture();
        requestWorkstationReset(root);
        // Locked exactly as they are on a real Windows machine. If the reset
        // touches them at all, it throws and this test sees it.
        const io = lockedFs(['runtime', 'pty-host', 'toolchain']);

        const outcome = applyPendingWorkstationReset(root, io);

        expect(io.removed).not.toContain('runtime');
        expect(io.removed).not.toContain('pty-host');
        expect(outcome.failures).toEqual([]);
        expect(fs.existsSync(path.join(root, 'runtime', '20.20.2-win32-x64', 'node.exe'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'pty-host', 'fth0.3.1-npty1.1.0', 'OpenConsole.exe')))
            .toBe(true);
        // POSITIVE CONTROL: the reset was alive while it preserved them.
        expect(fs.existsSync(path.join(root, 'genie.db'))).toBe(false);
    });
});

describe('a failed reset must not take the boot down (genie#349)', () => {
    function capture(): { reports: ResetFailure[][]; report: (f: ResetFailure[]) => void } {
        const reports: ResetFailure[][] = [];
        return { reports, report: (f) => reports.push(f) };
    }

    it('survives a reset that throws, and reports what it could not remove', () => {
        const root = fixture();
        requestWorkstationReset(root);
        const { reports, report } = capture();

        const outcome = applyWorkstationResetAtBoot(root, report, lockedFs(['plugins']));

        expect(outcome.applied).toBe(true);
        expect(reports).toHaveLength(1);
        expect(reports[0].map((f) => f.entry)).toEqual(['plugins']);
        // Boot got past it: the marker is gone and the rest was cleared.
        expect(fs.existsSync(path.join(root, '.reset-workstation'))).toBe(false);
        expect(fs.existsSync(path.join(root, 'genie.db'))).toBe(false);
    });

    it('survives a reset that cannot even list userData', () => {
        const root = fixture();
        requestWorkstationReset(root);
        const { reports, report } = capture();
        const io: ResetFs = {
            exists: (target) => fs.existsSync(target),
            list: () => {
                throw Object.assign(new Error('EPERM: operation not permitted, scandir'), {
                    code: 'EPERM',
                });
            },
            remove: (target) => fs.rmSync(target, { recursive: true, force: true }),
        };

        expect(() => applyWorkstationResetAtBoot(root, report, io)).not.toThrow();

        // Still cleared: the next boot must not re-run into the same wall.
        expect(fs.existsSync(path.join(root, '.reset-workstation'))).toBe(false);
        expect(reports).toHaveLength(1);
        expect(reports[0][0].message).toContain('EPERM');
    });

    it('stays silent when the reset completes cleanly', () => {
        const root = fixture();
        requestWorkstationReset(root);
        const { reports, report } = capture();

        applyWorkstationResetAtBoot(root, report);

        expect(reports).toEqual([]);
        expect(fs.existsSync(path.join(root, 'genie.db'))).toBe(false);
    });

    it('stays silent when no reset is pending', () => {
        const root = fixture();
        const { reports, report } = capture();

        expect(applyWorkstationResetAtBoot(root, report).applied).toBe(false);
        expect(reports).toEqual([]);
        expect(fs.existsSync(path.join(root, 'genie.db'))).toBe(true);
    });

    it('does not let a failing reporter become the thing that stops boot', () => {
        const root = fixture();
        requestWorkstationReset(root);

        expect(() =>
            applyWorkstationResetAtBoot(
                root,
                () => {
                    throw new Error('no window to report into');
                },
                lockedFs(['plugins']),
            ),
        ).not.toThrow();
        expect(fs.existsSync(path.join(root, '.reset-workstation'))).toBe(false);
    });
});

describe('boot wiring (genie#349)', () => {
    const boot = fs.readFileSync(path.join(__dirname, '..', '..', 'background.ts'), 'utf8');

    it('boots through the guarded entry point, never the raw reset', () => {
        expect(boot).toContain('applyWorkstationResetAtBoot(');
        expect(boot).not.toContain('applyPendingWorkstationReset(');
    });

    it('still applies the reset BEFORE the database opens the files', () => {
        const reset = boot.indexOf('applyWorkstationResetAtBoot(');
        const db = boot.indexOf('initDatabase(');

        // Both must be present, or the test is asserting nothing.
        expect(reset).toBeGreaterThan(-1);
        expect(db).toBeGreaterThan(-1);

        expect(reset).toBeLessThan(db);
    });
});
