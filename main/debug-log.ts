import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `--genie-debug`: write a startup log to a file the user can hand over.
 *
 * GENIE WRITES NO LOG FILE. There is no `electron-log`, no `getPath('logs')`
 * writer, nothing — so when Genie fails to start, everything it knows about why
 * goes to stderr and dies with the process. On Windows and macOS a user double-
 * clicks an icon and never sees stderr at all; on Linux an AppImage that exits
 * before its window appears looks, from the desktop, like nothing happened.
 *
 * That was the actual blocker on Omarchy: the only way to learn anything was to
 * talk the owner through launching from a terminal and redirecting output. This
 * makes the diagnostic a flag instead of a procedure.
 *
 * WHAT IT IS NOT: application logging. This captures the boot path and anything
 * that throws during it, so a failed start can be handed to someone who was not
 * at the keyboard. It is opt-in, off by default, and says where it wrote.
 *
 * PURE except for the explicit fs calls, and the path/redaction decisions are
 * separated out so they are testable without a filesystem.
 */

/**
 * The flag, and why it is not `--debug`.
 *
 * `--debug` is ELECTRON'S. Chromium/Node claim it before any of our code runs,
 * and Electron 42 answers it with
 *
 *     electron: [DEP0062]: `node --debug` and `node --debug-brk` are invalid.
 *     Please use `node --inspect` and `node --inspect-brk` instead.
 *
 * and then does not start normally. Verified by running the real AppImage on
 * Omarchy: `--debug` produced that line and no application. So the flag as
 * first shipped could never have written a log — the process it was meant to
 * diagnose never got far enough to open one.
 *
 * `--genie-debug` is namespaced for exactly that reason: the argv of an
 * Electron app is shared with Chromium and Node, and an unprefixed word is
 * somebody else's option waiting to happen.
 */
export const DEBUG_FLAG = '--genie-debug';

/** True when this process was started with {@link DEBUG_FLAG}. */
export function debugRequested(argv: readonly string[] = process.argv): boolean {
    return argv.includes(DEBUG_FLAG);
}

/**
 * Where the log goes.
 *
 * The temp directory, deliberately, rather than the app's own data directory:
 *
 *  - it is the same place on every OS and the user does not have to be told
 *    where their app-data lives,
 *  - it is world-readable and easy to attach to a message, which is the whole
 *    point of the file,
 *  - it is cleaned by the OS, so an opt-in diagnostic cannot quietly accumulate
 *    forever in a directory the user never looks at.
 *
 * The pid is in the name so a second launch (and the single-instance case,
 * where the second process quits immediately) does not overwrite the log of
 * the run that actually mattered.
 */
export function debugLogPath(now: Date = new Date(), pid: number = process.pid): string {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    return path.join(os.tmpdir(), `genie-debug-${stamp}-${pid}.log`);
}

/**
 * Values that must never reach a file the user will paste into a chat.
 *
 * A startup log names the environment, and this app's environment carries
 * project tokens, GitHub credentials and MCP bearer tokens. A diagnostic that
 * leaks a token is worse than no diagnostic: the user pastes it somewhere
 * public precisely because we told them to.
 *
 * Matched on the KEY, not the value — a value-shaped heuristic misses a token
 * that happens to look ordinary, and the key is what we control.
 */
const SECRET_KEY = /(token|secret|password|passwd|key|credential|auth|bearer|cookie|session)/i;

/** Keys that match the pattern but are safe, and useful, to see. */
const SECRET_ALLOW = /^(.*_?keyboard.*|.*keymap.*|xdg_session_type|.*_key_layout)$/i;

/** True when an env var's name means its value must not be written. */
export function isSecretKey(key: string): boolean {
    if (SECRET_ALLOW.test(key)) return false;
    return SECRET_KEY.test(key);
}

/**
 * The environment worth recording, with secrets redacted.
 *
 * Deliberately NOT the whole environment. A start failure is almost always
 * about the display server, the session type or the sandbox, so those are
 * named — and everything else is summarised as a count rather than dumped,
 * which keeps the file short enough that someone will actually read it.
 */
export const DIAGNOSTIC_ENV_KEYS = [
    'XDG_SESSION_TYPE',
    'XDG_CURRENT_DESKTOP',
    'WAYLAND_DISPLAY',
    'DISPLAY',
    'HYPRLAND_INSTANCE_SIGNATURE',
    'APPIMAGE',
    'APPDIR',
    'SHELL',
    'LANG',
] as const;

export function debugEnvSummary(
    env: Readonly<Record<string, string | undefined>> = process.env,
    // Injectable so a test can prove the redaction actually applies to whatever
    // is printed. With the list hard-coded, "no secret value appears" passed
    // even with redaction disabled -- the allow-list was doing all the work and
    // the redaction assertion was vacuous.
    interesting: readonly string[] = DIAGNOSTIC_ENV_KEYS,
): string[] {
    const lines = interesting.map((key) => {
        const value = env[key];
        if (value === undefined) return `${key}=<unset>`;
        return `${key}=${isSecretKey(key) ? '<redacted>' : value}`;
    });
    const redacted = Object.keys(env).filter(isSecretKey).length;
    lines.push(`(${Object.keys(env).length} env vars total, ${redacted} redacted by name)`);
    return lines;
}

/** The header every debug log opens with — what ran, where, and on what. */
export function debugHeader(info: {
    version: string;
    electron: string;
    argv: readonly string[];
}): string[] {
    return [
        `Genie ${info.version} — startup debug log`,
        `written ${new Date().toISOString()}`,
        '',
        `platform   ${process.platform} ${process.arch} (${os.release()})`,
        `electron   ${info.electron}`,
        `node       ${process.versions.node}`,
        `pid        ${process.pid}`,
        `argv       ${info.argv.join(' ')}`,
        '',
        'environment:',
        ...debugEnvSummary().map((line) => `  ${line}`),
        '',
        '--- boot ---',
    ];
}

/** A file-backed logger, or a no-op when `--debug` was not passed. */
export interface DebugLog {
    /** True when this run is actually writing a file. */
    readonly active: boolean;
    /** The file being written, or null when inactive. */
    readonly file: string | null;
    /** Append one line. Never throws — a broken log must not break the boot. */
    note(message: string): void;
    /** Append an error with its stack. */
    fail(context: string, error: unknown): void;
}

const inactive: DebugLog = {
    active: false,
    file: null,
    note: () => {},
    fail: () => {},
};

/**
 * Open the debug log for this run, or return a no-op when the flag is absent.
 *
 * Every write is wrapped: a diagnostic that crashes the thing it is diagnosing
 * is worse than none, and this runs before almost everything else in boot.
 */
export function openDebugLog(info: {
    version: string;
    electron: string;
    argv?: readonly string[];
}): DebugLog {
    const argv = info.argv ?? process.argv;
    if (!debugRequested(argv)) return inactive;

    const file = debugLogPath();
    const append = (text: string): void => {
        try {
            fs.appendFileSync(file, text + '\n', 'utf8');
        } catch {
            /* best-effort — never let logging break the boot it is recording */
        }
    };

    try {
        fs.writeFileSync(file, '', 'utf8');
    } catch {
        return inactive; // cannot write there at all; boot normally
    }

    for (const line of debugHeader({ ...info, argv })) append(line);

    // Say it on stdout too. A user who ran with the flag is at a terminal, and
    // the path is the one thing they need out of this.
    // eslint-disable-next-line no-console
    console.log(`[Genie] ${DEBUG_FLAG}: writing startup log to ${file}`);

    return {
        active: true,
        file,
        note: (message: string) => append(`${new Date().toISOString()}  ${message}`),
        fail: (context: string, error: unknown) => {
            const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
            append(`${new Date().toISOString()}  FAILED ${context}`);
            for (const line of detail.split('\n')) append(`    ${line}`);
        },
    };
}
