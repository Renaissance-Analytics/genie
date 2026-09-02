import os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
    DEBUG_FLAG,
    debugRequested,
    debugLogPath,
    isSecretKey,
    debugEnvSummary,
    debugHeader,
    openDebugLog,
} from '../debug-log';

/**
 * `--genie-debug` exists because Genie writes NO log file.
 *
 * There is no electron-log and no `getPath('logs')` writer anywhere in `main/`,
 * so everything Genie knows about a failed start goes to stderr and dies with
 * the process. A user who double-clicks an icon never sees stderr; an AppImage
 * that exits before its window appears looks, from the desktop, like nothing
 * happened at all. That was the actual blocker diagnosing Omarchy — the only
 * route to any evidence was talking someone through a terminal launch with a
 * redirect.
 *
 * The tests that matter here are the REDACTION ones. This file's whole purpose
 * is to be handed to someone else, and this app's environment carries project
 * tokens, GitHub credentials and MCP bearer tokens. A diagnostic that leaks a
 * secret is worse than no diagnostic, because we are the reason it got pasted
 * somewhere public.
 */

describe('opting in', () => {
    /**
     * THE FLAG IS NOT `--debug`, and this is the test that matters.
     *
     * `--debug` is Electron's. Chromium/Node claim it before any of our code
     * runs, and Electron 42 answers it with DEP0062 ("`node --debug` ... are
     * invalid") and then does not start normally.
     *
     * Found by running the real AppImage on Omarchy: `--debug` produced that
     * line and no application. So the flag as first shipped could never have
     * written a log -- the process it was meant to diagnose never got far
     * enough to open one. A unit test could not have caught it; only running
     * the built artifact could.
     */
    it('is namespaced, because --debug belongs to Electron', () => {
        expect(DEBUG_FLAG).toBe('--genie-debug');
        expect(debugRequested(['electron', '.', '--debug'])).toBe(false);
    });

    it('is off unless the flag is passed', () => {
        expect(debugRequested(['electron', '.'])).toBe(false);
        expect(debugRequested(['electron', '.', '--autostart'])).toBe(false);
    });

    it('is on with the flag', () => {
        expect(debugRequested(['electron', '.', DEBUG_FLAG])).toBe(true);
    });

    it('writes nothing when it is off', () => {
        const log = openDebugLog({ version: '0.0.0', electron: '42', argv: ['electron', '.'] });

        expect(log.active).toBe(false);
        expect(log.file).toBe(null);
        // The no-op must be safe to call, or every call site needs a guard.
        expect(() => log.note('x')).not.toThrow();
        expect(() => log.fail('x', new Error('y'))).not.toThrow();
    });
});

describe('where it writes', () => {
    it('goes to the temp directory, the same place on every OS', () => {
        expect(debugLogPath().startsWith(os.tmpdir())).toBe(true);
    });

    it('names the file with a timestamp and pid, so a second run cannot clobber the first', () => {
        const at = new Date('2026-09-02T06:43:38.640Z');

        expect(debugLogPath(at, 4242)).toContain('4242');
        expect(debugLogPath(at, 4242)).toContain('2026-09-02');
        expect(debugLogPath(at, 4242)).not.toBe(debugLogPath(at, 4243));
    });

    it('uses no characters a path cannot hold', () => {
        // toISOString has colons, which are illegal in a Windows filename and
        // would make the whole feature fail on the platform most likely to need
        // it (no terminal, no stderr).
        const name = debugLogPath(new Date('2026-09-02T06:43:38.640Z'), 1).split(/[\\/]/).pop()!;

        expect(name).not.toContain(':');
    });
});

/* ── the half that must not get this wrong ──────────────────────────────── */

describe('redaction', () => {
    it('redacts anything whose NAME says it is a secret', () => {
        for (const key of [
            'GITHUB_TOKEN',
            'ANTHROPIC_API_KEY',
            'AWS_SECRET_ACCESS_KEY',
            'REVERB_APP_SECRET',
            'DB_PASSWORD',
            'TYNN_BEARER',
            'SESSION_COOKIE',
            'some_credential_thing',
        ]) {
            expect(isSecretKey(key)).toBe(true);
        }
    });

    it('POSITIVE CONTROL: does not redact the ordinary vars the log exists to show', () => {
        // Without this, "redacts secrets" passes on a function that redacts
        // EVERYTHING — which would produce a useless file that still looks safe.
        for (const key of ['XDG_SESSION_TYPE', 'WAYLAND_DISPLAY', 'DISPLAY', 'SHELL', 'LANG']) {
            expect(isSecretKey(key)).toBe(false);
        }
    });

    it('keeps the diagnostic vars readable in the summary', () => {
        const lines = debugEnvSummary({
            XDG_SESSION_TYPE: 'wayland',
            WAYLAND_DISPLAY: 'wayland-1',
            GITHUB_TOKEN: 'ghp_realsecret',
        });
        const text = lines.join('\n');

        expect(text).toContain('XDG_SESSION_TYPE=wayland');
        expect(text).toContain('WAYLAND_DISPLAY=wayland-1');
    });

    /**
     * The value path, exercised HONESTLY.
     *
     * The first version of this test set secret env vars and asserted their
     * values were absent — and it passed with redaction switched off, because
     * `debugEnvSummary` only prints an allow-list those keys were not on. The
     * allow-list was doing all the work and the assertion proved nothing.
     *
     * Caught by deliberately breaking `isSecretKey` and noticing this test
     * stayed green. So the key list is injectable now, and this forces a
     * secret-named var THROUGH the printing path — which is the case that
     * happens for real the day someone adds a token-bearing var to
     * DIAGNOSTIC_ENV_KEYS without thinking about it.
     */
    it('redacts a secret VALUE even when the key is one being printed', () => {
        const text = debugEnvSummary(
            { XDG_SESSION_TYPE: 'wayland', GITHUB_TOKEN: 'ghp_realsecret' },
            ['XDG_SESSION_TYPE', 'GITHUB_TOKEN'],
        ).join('\n');

        expect(text).not.toContain('ghp_realsecret');
        expect(text).toContain('GITHUB_TOKEN=<redacted>');
        // POSITIVE CONTROL: the same call still prints the ordinary one, so
        // this is redaction rather than the whole line being dropped.
        expect(text).toContain('XDG_SESSION_TYPE=wayland');
    });

    it('prints only the allow-listed keys, so an unlisted secret cannot appear at all', () => {
        // The other half of the guarantee, and the one that holds even if
        // isSecretKey is wrong: a var nobody listed is never printed.
        const text = debugEnvSummary({
            XDG_SESSION_TYPE: 'wayland',
            SOME_INTERNAL_VALUE: 'not-a-secret-by-name-but-still-private',
        }).join('\n');

        expect(text).not.toContain('not-a-secret-by-name-but-still-private');
    });

    it('says how many it redacted, so a reader knows the file is filtered', () => {
        const text = debugEnvSummary({ GITHUB_TOKEN: 'x', DB_PASSWORD: 'y', LANG: 'en' }).join('\n');

        expect(text).toContain('2 redacted by name');
    });

    it('reports an unset diagnostic var as unset rather than omitting it', () => {
        // "WAYLAND_DISPLAY is absent" is itself the finding on a Wayland box.
        // Dropping the line makes it indistinguishable from a log that never
        // looked.
        expect(debugEnvSummary({}).join('\n')).toContain('WAYLAND_DISPLAY=<unset>');
    });
});

describe('the header', () => {
    it('records what ran, on what, with which arguments', () => {
        const text = debugHeader({
            version: '0.7.0-beta.295',
            electron: '42.8.1',
            argv: ['genie', DEBUG_FLAG],
        }).join('\n');

        expect(text).toContain('0.7.0-beta.295');
        expect(text).toContain('42.8.1');
        expect(text).toContain(DEBUG_FLAG);
        expect(text).toContain(process.platform);
    });
});
