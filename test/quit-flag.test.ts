import { describe, expect, it } from 'vitest';
import { QUIT_ARG, QUIT_DATA, asksToQuit, launchDecision, secondInstanceAction } from '../src/core/quit-flag.js';

/**
 * `Genie --quit` — the pure half (core/quit-flag.ts). A graceful quit from outside: a second launch hands it to the
 * running Genie and exits without a window; with no Genie running it exits without booting one. A plain second launch
 * still reveals the first one's window. main.ts's wiring of it is guarded in tray-main-wiring.test.ts.
 */

// Argv the way each launch actually carries it: the installed exe, Electron run from a tree, and a second instance's
// argv as Chromium hands it to the first (switches of its own added around the person's).
const INSTALLED = ['C:\\Users\\example\\AppData\\Local\\Programs\\Genie\\Genie.exe'];
const FROM_TREE = ['/work/node_modules/electron/dist/electron', '.', '--remote-debugging-port=9222'];
const APPIMAGE = ['/home/example/Genie.AppImage', '--no-sandbox'];
const CHROMIUM_SECOND = ['C:\\Users\\example\\AppData\\Local\\Programs\\Genie\\Genie.exe', '--allow-file-access-from-files', '--original-process-start-time=13370000000000000'];

describe('asksToQuit — `--quit` among Electron\u2019s own argv', () => {
    it('recognises --quit wherever it sits', () => {
        expect(asksToQuit([...INSTALLED, QUIT_ARG])).toBe(true);
        expect(asksToQuit([...FROM_TREE, QUIT_ARG])).toBe(true);
        expect(asksToQuit([FROM_TREE[0]!, QUIT_ARG, ...FROM_TREE.slice(1)])).toBe(true);
        expect(asksToQuit([...APPIMAGE, QUIT_ARG])).toBe(true);
        expect(asksToQuit([CHROMIUM_SECOND[0]!, '--allow-file-access-from-files', QUIT_ARG, '--original-process-start-time=1'])).toBe(true);
    });

    it('CONTROL: a launch without it does not ask — plain, --hidden, --doctor, and Chromium\u2019s own switches', () => {
        for (const argv of [INSTALLED, FROM_TREE, APPIMAGE, CHROMIUM_SECOND, [...INSTALLED, '--hidden'], [...INSTALLED, '--doctor']]) {
            expect(asksToQuit(argv)).toBe(false);
        }
    });

    it('only the whole argument: not a prefix, not a value, not a path that contains it', () => {
        expect(asksToQuit([...INSTALLED, '--quit-now'])).toBe(false);
        expect(asksToQuit([...INSTALLED, '--quit=1'])).toBe(false);
        expect(asksToQuit([...INSTALLED, 'C:\\work\\--quit\\file.txt'])).toBe(false);
        expect(asksToQuit([...INSTALLED, '-quit'])).toBe(false);
    });
});

describe('launchDecision — only a first instance asked to run Genie boots (and only boot creates a window)', () => {
    it('a plain first launch boots', () => {
        expect(launchDecision({ argv: INSTALLED, primary: true })).toEqual({ kind: 'boot' });
        expect(launchDecision({ argv: FROM_TREE, primary: true })).toEqual({ kind: 'boot' });
    });

    it('--quit with no Genie running exits without booting one', () => {
        const d = launchDecision({ argv: [...INSTALLED, QUIT_ARG], primary: true });
        expect(d.kind).toBe('exit');
        expect(d.kind === 'exit' && d.reason).toMatch(/no Genie is running/);
    });

    it('a second instance never boots — with --quit it has asked the first to quit; without, the first reveals', () => {
        const quit = launchDecision({ argv: [...INSTALLED, QUIT_ARG], primary: false });
        const plain = launchDecision({ argv: INSTALLED, primary: false });
        expect(quit.kind).toBe('exit');
        expect(plain.kind).toBe('exit');
        expect(quit.kind === 'exit' && quit.reason).toMatch(/quit/);
        expect(plain.kind === 'exit' && plain.reason).toMatch(/already running/);
    });
});

describe('secondInstanceAction — what the running Genie does with a second launch', () => {
    it('--quit in the argv quits', () => {
        expect(secondInstanceAction([...INSTALLED, QUIT_ARG], {})).toBe('quit');
    });

    it('the quit rides additionalData too, so an argv Chromium rewrote still quits', () => {
        expect(secondInstanceAction(CHROMIUM_SECOND, { ...QUIT_DATA })).toBe('quit');
    });

    it('CONTROL: a plain second launch still reveals the window', () => {
        expect(secondInstanceAction(INSTALLED, {})).toBe('reveal');
        expect(secondInstanceAction(CHROMIUM_SECOND, undefined)).toBe('reveal');
        expect(secondInstanceAction(INSTALLED, null)).toBe('reveal');
        expect(secondInstanceAction([...INSTALLED, '--hidden'], { genie: 'open' })).toBe('reveal');
        expect(secondInstanceAction(INSTALLED, 'quit')).toBe('reveal');
    });
});
