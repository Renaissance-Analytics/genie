import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldShowMasterWindowOnBoot } from '../reopen-after-update';

/**
 * The boot decision that regressed: after an auto-update relaunch Genie stayed
 * in the tray instead of reopening its window. The window-show gate (added with
 * the "start minimized" setting) suppresses the open on an autostart launch, and
 * on Windows the updater's relaunch looks like one — so the user's actively-used
 * window silently vanished on every upgrade.
 *
 * The fix records the update-apply intent explicitly and lets it override the
 * autostart suppression, while still honouring the user's deliberate
 * `start_minimized` choice.
 */
describe('shouldShowMasterWindowOnBoot', () => {
    const base = {
        isE2E: false,
        fromAutostart: false,
        startMinimized: false,
        reopenAfterUpdate: false,
    };

    it('opens by default (a plain launch, default settings)', () => {
        expect(shouldShowMasterWindowOnBoot(base)).toBe(true);
    });

    it('stays in the tray on an autostart (OS sign-in) launch', () => {
        expect(shouldShowMasterWindowOnBoot({ ...base, fromAutostart: true })).toBe(false);
    });

    it('REOPENS after an update even when the relaunch looks like autostart — the regression', () => {
        expect(
            shouldShowMasterWindowOnBoot({ ...base, fromAutostart: true, reopenAfterUpdate: true }),
        ).toBe(true);
    });

    it('still honours an explicit start_minimized preference, even after an update', () => {
        // A deliberate "tray only" choice is not overridden by an update.
        expect(
            shouldShowMasterWindowOnBoot({ ...base, startMinimized: true, reopenAfterUpdate: true }),
        ).toBe(false);
    });

    it('never opens under E2E — the harness owns its window', () => {
        expect(shouldShowMasterWindowOnBoot({ ...base, isE2E: true })).toBe(false);
        expect(
            shouldShowMasterWindowOnBoot({ ...base, isE2E: true, reopenAfterUpdate: true }),
        ).toBe(false);
    });
});

/**
 * IS THE PREDICATE ACTUALLY CALLED?
 *
 * Everything above tests what `shouldShowMasterWindowOnBoot` DECIDES. None of it noticed
 * when nothing asked it.
 *
 * `c1cd4e71` — a commit about keeping the E2E rig out of the shipped binary — replaced the
 * region of `background.ts` that held the call, and took it with it. The function kept
 * compiling, kept its import, and kept passing every test in this file, while Genie booted
 * with no window at all. Agents revive at boot, so the machine came up with every agent
 * working and no surface to reach them from.
 *
 * A pure function with no caller is the defect this release has spent its day on, in its
 * most expensive form: the unit tests stay green and the product loses a window.
 *
 * `main/background.ts` is documented here as effectively untestable — no DI seam, Electron
 * at module scope — so this reads the SOURCE. A source guard is weaker than an integration
 * test and stronger than nothing, which is what was watching this before.
 */
describe('the boot path actually asks', () => {
    const background = fs.readFileSync(
        path.join(__dirname, '..', '..', 'background.ts'),
        'utf8',
    );
    // Comments stripped: this file's own name now appears in prose there, and a guard that a
    // COMMENT can satisfy is a guard that proves nothing.
    const code = background
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

    it('POSITIVE CONTROL: the guard is reading the real file', () => {
        // Without this, every assertion below would also pass against an empty string.
        expect(code).toContain('showMasterWindow');
        expect(code.length).toBeGreaterThan(50_000);
    });

    it('CALLS shouldShowMasterWindowOnBoot, not merely imports it', () => {
        // The import alone is what survived c1cd4e71. Requiring the open-paren is what
        // separates a live call from a name that only appears in an import list.
        expect(code).toMatch(/shouldShowMasterWindowOnBoot\s*\(/);
    });

    it('opens the window inside that decision', () => {
        // The call could exist and its answer be dropped. This pins that the branch acts.
        const at = code.search(/shouldShowMasterWindowOnBoot\s*\(/);
        expect(at).toBeGreaterThan(-1);
        expect(code.slice(at, at + 600)).toContain('showMasterWindow()');
    });

    it('clears the one-shot reopen flag before deciding', () => {
        // Left set, it reopens on EVERY boot thereafter, not just the one after an update.
        expect(code).toContain('REOPEN_AFTER_UPDATE_KEY');
        expect(code).toMatch(/setSettings\(\{\s*\[REOPEN_AFTER_UPDATE_KEY\]/);
    });
});
