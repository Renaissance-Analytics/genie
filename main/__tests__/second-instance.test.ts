import { describe, expect, it } from 'vitest';
import { secondInstanceAction } from '../second-instance';

/**
 * A SCRIPT RUNNING `genie --version` MUST NOT YANK THE WINDOW FORWARD.
 *
 * The owner, about the Settings window: *"makes the settings window hide on me
 * every time I click on it when it is loading the lists… it seems to do it any
 * time it scans."*
 *
 * Measured, not guessed. A foreground-window trace and Genie's own boot log line
 * up to the millisecond:
 *
 *     01:33:24.192  foreground → Genie (main window)
 *     06:33:24.231Z boot.log:  "+0ms start" … "toolchain", never "ready"
 *
 * A boot that reaches `toolchain` and stops is a SECOND Genie process quitting on
 * the single-instance lock. The first instance's `second-instance` handler then
 * raised the main window — so Settings went behind it, every scan.
 *
 * THE HANDLER IS THE DEFECT, whatever is doing the launching. It raised for any
 * argv that was not a `genie://` URL, so it could not tell a person
 * double-clicking the icon from a background `--version`.
 *
 * The rule (the owner's choice): raise only for a BARE launch.
 *
 * Three theories preceded this one and two were disproved by measuring — the
 * probes do not steal foreground, and none of the 28 commands the scan runs
 * launches Genie. What launches it is STILL unidentified, which is why the
 * ignore path reports the argv instead of discarding it.
 */
const EXE = 'C:/Users/x/AppData/Local/Programs/Genie/Genie.exe';

describe('secondInstanceAction', () => {
    it('RAISES for a bare launch — a double-click or the taskbar', () => {
        expect(secondInstanceAction([EXE])).toMatchObject({ kind: 'raise' });
    });

    it('does NOT raise for a --version probe', () => {
        // THE case. This is what put Settings behind the main window on every scan.
        expect(secondInstanceAction([EXE, '--version']).kind).toBe('ignore');
    });

    it('does not raise for any other tool invocation', () => {
        for (const arg of ['--help', 'host', 'host restart', '--genie-debug']) {
            expect(secondInstanceAction([EXE, arg]).kind, arg).toBe('ignore');
        }
    });

    it('STILL handles a genie:// deep link', () => {
        // POSITIVE CONTROL: the url path is how browser sign-in and workstation
        // connect come back. Suppressing it would break them silently.
        const out = secondInstanceAction([EXE, 'genie://workstation/open?id=w1']);
        expect(out).toEqual({ kind: 'url', url: 'genie://workstation/open?id=w1' });
    });

    it('prefers a genie:// url even when other args are present', () => {
        // A protocol launch can carry OS-added switches; the url is the intent.
        expect(
            secondInstanceAction([EXE, '--some-os-flag', 'genie://oauth/callback?token=t']),
        ).toMatchObject({ kind: 'url' });
    });

    it('REPORTS the argv it declined to raise for', () => {
        // The launcher is still unidentified. Without this the next occurrence
        // costs the owner another reproduction; with it, it names itself.
        const out = secondInstanceAction([EXE, '--version']);
        expect(out.kind === 'ignore' && out.argv).toContain('--version');
    });

    it('treats an empty argv as a bare launch rather than crashing', () => {
        // Electron's argv shape is platform-dependent, and this runs inside an
        // event handler with no caller to catch a throw.
        expect(secondInstanceAction([]).kind).toBe('raise');
    });

    it('ignores the executable path itself when deciding', () => {
        // argv[0] is always the exe. Counting it as an argument would mean
        // NOTHING ever raises — a lock-out rather than a fix.
        expect(secondInstanceAction(['/usr/local/bin/genie']).kind).toBe('raise');
    });
});

/**
 * The decision is inert unless the HANDLER uses it. `background.ts` has no unit
 * harness (it drags the Electron bootstrap in), so the wiring is guarded in
 * source — and here a silent break restores exactly the reported bug.
 */
import fs from 'node:fs';
import path from 'node:path';

const BG = fs.readFileSync(path.resolve(__dirname, '../background.ts'), 'utf8');
const HANDLER = BG.slice(BG.indexOf("app.on('second-instance'"), BG.indexOf("app.on('open-url'"));

describe('the second-instance handler uses the rule', () => {
    it('asks secondInstanceAction rather than deciding inline', () => {
        expect(HANDLER).toMatch(/secondInstanceAction\(argv\)/);
    });

    it('raises ONLY on the raise verdict', () => {
        // The regression this guards: `showMainWindow()` reachable on any path
        // other than `kind === 'raise'` is the original bug restored.
        const raises = HANDLER.match(/showMainWindow\(\)/g) ?? [];
        expect(raises).toHaveLength(1);
        expect(HANDLER).toMatch(/action\.kind === 'raise'[\s\S]{0,120}showMainWindow\(\)/);
    });

    it('still routes a genie:// url', () => {
        expect(HANDLER).toMatch(/action\.kind === 'url'[\s\S]{0,120}handleGenieUrl\(action\.url\)/);
    });

    it('LOGS the ignored invocation', () => {
        // The launcher is still unknown. This line is the whole plan for finding
        // it without asking the owner to reproduce again.
        expect(HANDLER).toMatch(/logHostService\(/);
        expect(HANDLER).toMatch(/action\.argv/);
    });
});
