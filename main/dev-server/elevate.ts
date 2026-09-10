/**
 * Running commands with OS elevation, for the privileged bits of host-native
 * hosting (story #238): installing the Genie CA into the trust store and writing
 * the OS hosts file.
 *
 * Two paths, one contract:
 *   - Already privileged (root on Linux/CI, or an elevated Windows process) →
 *     spawn DIRECTLY. This is what the Ubuntu CI E2E runs, so it's the tested,
 *     load-bearing path.
 *   - Not privileged (a normal local machine) → spawn through the OS elevation
 *     launcher (UAC `Start-Process -Verb RunAs` / `pkexec` / `osascript` admin),
 *     which prompts the user once. Only the user's own run validates this.
 *
 * ONE PROMPT PER PASS (genie#604). Elevation is charged per launcher invocation,
 * not per command, so a reconcile that needs both the trust install and a hosts
 * write used to cost the owner TWO administrator approvals for one action. The
 * unit here is therefore a BATCH: {@link runPrivilegedBatch} takes the whole set
 * a pass needs and elevates once, and an empty set elevates not at all.
 *
 * A batch has to stay legible when it fails, which is the constraint that shapes
 * the generated scripts. Windows hands back nothing but the elevated process's
 * exit code — the elevated child has its own console, so its stderr never
 * reaches us — so the script encodes the FAILING STEP'S INDEX in its exit code
 * ({@link PRIVILEGED_STEP_EXIT_BASE} + i). The unix script also prints a marker
 * to stderr, because osascript flattens every failure to exit 1 while passing
 * the failed command's stderr back inside its error text. Between the two, a
 * batched failure still names which action failed, which is the whole point:
 * one opaque "elevated batch failed" would be worse than the two prompts.
 *
 * Every operation is spawned with an argv array (no shell at the Node level), and
 * a non-zero exit is surfaced LOUDLY — never a silent "trusted"/"resolves" when
 * it didn't.
 */

export interface PrivilegedRun {
    cmd: string;
    args: string[];
}

/** One command in a batch, carrying the identity needed to report a partial
 *  failure BY NAME rather than as an anonymous "something elevated failed". */
export interface PrivilegedStep {
    /** Stable machine id — `'ca-trust'`, `'hosts-file'`. For logs and tests. */
    id: string;
    /** What it does, phrased as the tail of "Genie could not …":
     *  `'update the hosts file'`. This is user-visible copy. */
    label: string;
    run: PrivilegedRun;
}

export type PrivilegedBatchResult =
    | { ok: true }
    | {
          ok: false;
          /** The step that failed, or `null` when the ELEVATION itself failed
           *  (prompt dismissed, launcher missing) and so nothing ran. */
          step: PrivilegedStep | null;
          error: string;
      };

/** Exit code of a batch whose step `i` failed: BASE + i. Chosen to sit above the
 *  codes commands realistically return and below pkexec's own 126/127, so a
 *  step failure is never confused with the launcher failing. */
export const PRIVILEGED_STEP_EXIT_BASE = 90;

/** Longest batch whose step indices still fit under pkexec's reserved 126. Far
 *  more than the two steps a reconcile actually needs — it is a guard, not a
 *  budget, so an accidental fan-out fails loudly instead of mis-attributing. */
export const MAX_PRIVILEGED_STEPS = 30;

/** The stderr marker the unix batch prints before bailing out of step `i` — the
 *  attribution channel for macOS, where osascript collapses the exit code. */
export function privilegedStepMarker(index: number): string {
    return `genie-privileged-step:${index}`;
}

const STEP_MARKER_RE = /genie-privileged-step:(\d+)/;

export interface PrivilegedBatchDeps {
    platform: NodeJS.Platform;
    /** Whether the current process can run the commands without a prompt. */
    isElevated: () => boolean;
    /** Spawn a command to completion (argv, no shell). */
    spawn: (cmd: string, args: string[]) => Promise<{ code: number; stderr?: string }>;
}

/**
 * Run every step under ONE elevation (or directly, when already privileged),
 * stopping at the first failure and naming the step that caused it.
 *
 * An EMPTY batch does nothing at all — no spawn, no prompt. That is what keeps
 * the steady state (hosts file in sync, CA already trusted) silent, and it is
 * enforced here rather than left to each caller to remember.
 */
export async function runPrivilegedBatch(
    steps: PrivilegedStep[],
    deps: PrivilegedBatchDeps,
): Promise<PrivilegedBatchResult> {
    if (steps.length === 0) return { ok: true };

    if (deps.isElevated()) {
        // Already privileged: no prompt to save, so run the steps as themselves.
        // Attribution is exact and no shell quoting is involved — this is the CI
        // path, and the one the E2E suite exercises.
        for (const step of steps) {
            const r = await deps.spawn(step.run.cmd, step.run.args);
            if (r.code !== 0) return { ok: false, step, error: failureText(r) };
        }
        return { ok: true };
    }

    const [cmd, ...args] = elevationBatchArgv(
        steps.map((s) => s.run),
        deps.platform,
    );
    const r = await deps.spawn(cmd, args);
    if (r.code === 0) return { ok: true };
    return { ok: false, step: attributeFailure(steps, r), error: failureText(r) };
}

/** Which step a failed batch died on — the stderr marker where the platform
 *  passes stderr back, else the encoded exit code, else `null` (the launcher
 *  itself failed, so no step ran and none may be blamed). */
function attributeFailure(steps: PrivilegedStep[], r: { code: number; stderr?: string }): PrivilegedStep | null {
    const marked = r.stderr?.match(STEP_MARKER_RE);
    if (marked) return steps[Number(marked[1])] ?? null;
    const index = r.code - PRIVILEGED_STEP_EXIT_BASE;
    if (index >= 0 && index < steps.length) return steps[index];
    return null;
}

/** The message to show for a failure: the command's own words where we have
 *  them, with our marker line stripped (it is machinery, not a message). */
function failureText(r: { code: number; stderr?: string }): string {
    const cleaned = (r.stderr ?? '')
        .split(/\r?\n/)
        .map((line) => line.replace(STEP_MARKER_RE, '').trim())
        .filter((line) => line !== '')
        .join('\n')
        .trim();
    return cleaned || `command exited ${r.code}`;
}

/** Whether the current process can already run privileged commands without a
 *  prompt. On Windows we assume NOT (route through UAC) — a normal dev process is
 *  unelevated, and an already-elevated one still runs RunAs fine (no re-prompt). */
export function isProcessElevated(platform: NodeJS.Platform = process.platform): boolean {
    if (platform === 'win32') return false;
    return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** POSIX single-quoting: everything inside is literal, and an embedded `'` is
 *  closed, escaped and reopened — which INTRODUCES a backslash, the reason the
 *  AppleScript literal below must escape backslashes before quotes. */
function shQuote(a: string): string {
    return `'${a.replace(/'/g, "'\\''")}'`;
}

/** PowerShell single-quoting: literal (backslashes need no escaping), with an
 *  embedded `'` DOUBLED. */
function psQuote(a: string): string {
    return `'${a.replace(/'/g, "''")}'`;
}

/**
 * The argv that runs a whole SET of commands under ONE elevation prompt, per OS.
 * Each command is run in order; the first non-zero exit ends the batch with
 * {@link PRIVILEGED_STEP_EXIT_BASE} + its index, so the caller can say which one
 * failed (see the module docblock for why that is the only channel Windows has).
 *
 * The generated strings are the delicate part — three shells, three quoting
 * rules — so they are asserted verbatim in `__tests__/elevate.test.ts` rather
 * than eyeballed. Nothing here may be "simplified" without that test agreeing.
 */
export function elevationBatchArgv(runs: PrivilegedRun[], platform: NodeJS.Platform): string[] {
    if (runs.length === 0) throw new Error('elevationBatchArgv: refusing to elevate for zero commands');
    if (runs.length > MAX_PRIVILEGED_STEPS) {
        throw new Error(`elevationBatchArgv: at most ${MAX_PRIVILEGED_STEPS} steps per elevation`);
    }

    if (platform === 'win32') {
        // The elevated side is a PowerShell script, handed over as base64 UTF-16LE
        // (`-EncodedCommand`). That is what keeps the caller's quotes off THREE
        // nested command lines (our `-Command`, Start-Process's -ArgumentList
        // joining, and the elevated process's own parsing) — the alternative is
        // three layers of escaping that only fail once a path contains a quote.
        const script = [
            ...runs.flatMap((r, i) => [
                `& ${psQuote(r.cmd)}${r.args.map((a) => ` ${psQuote(a)}`).join('')}`,
                `if ($LASTEXITCODE -ne 0) { exit ${PRIVILEGED_STEP_EXIT_BASE + i} }`,
            ]),
            'exit 0',
        ].join('\n');
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        // `-PassThru` + `exit $p.ExitCode` is what carries the elevated failure
        // back at all: `Start-Process -Wait` alone returns nothing, so the outer
        // PowerShell would exit 0 however the elevated command fared. A dismissed
        // prompt yields no process object — that must read as failure, not success.
        const inner =
            `$ErrorActionPreference='Stop'; ` +
            `$p = Start-Process -FilePath 'powershell' ` +
            `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' ` +
            `-Verb RunAs -Wait -PassThru; ` +
            `if ($null -eq $p) { exit 1 }; exit $p.ExitCode`;
        return ['powershell', '-NoProfile', '-Command', inner];
    }

    // Both unix platforms run the SAME /bin/sh script; only the wrapper differs.
    const script = runs
        .map((r, i) => {
            const cmdline = [r.cmd, ...r.args].map(shQuote).join(' ');
            const marker = shQuote(privilegedStepMarker(i));
            return `${cmdline} || { echo ${marker} >&2; exit ${PRIVILEGED_STEP_EXIT_BASE + i}; }`;
        })
        .join('; ');

    if (platform === 'darwin') {
        // AppleScript string literal: backslash is the escape char, so escape `\`
        // BEFORE `"` — otherwise a backslash in the sh string (every '\'' quote
        // escape produces one) reaches AppleScript unescaped and corrupts the
        // command. Order matters: doubling backslashes first, then quotes.
        const literal = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return ['osascript', '-e', `do shell script "${literal}" with administrator privileges`];
    }
    return ['pkexec', '/bin/sh', '-c', script];
}

/** The argv that runs ONE `cmd args` elevated, per OS — the single-command
 *  launcher the toolchain installer still elevates through (one install, one
 *  prompt, nothing to batch). Host-native hosting uses
 *  {@link elevationBatchArgv} instead. Linux uses pkexec (clean argv, no shell);
 *  Windows wraps in PowerShell `Start-Process -Verb RunAs`; macOS uses
 *  osascript's administrator prompt. Values are our own controlled paths, but are
 *  quoted for the shells that need it. */
export function elevationLauncherArgv(cmd: string, args: string[], platform: NodeJS.Platform): string[] {
    if (platform === 'win32') {
        const ps = [cmd, ...args].map(psQuote);
        const fileArg = ps[0];
        const argList = ps.slice(1).join(',');
        const inner = argList
            ? `Start-Process -FilePath ${fileArg} -ArgumentList ${argList} -Verb RunAs -Wait`
            : `Start-Process -FilePath ${fileArg} -Verb RunAs -Wait`;
        return ['powershell', '-NoProfile', '-Command', inner];
    }
    if (platform === 'darwin') {
        const shell = [cmd, ...args].map(shQuote).join(' ');
        // Same escaping order as the batch generator above, for the same reason.
        const literal = shell.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return ['osascript', '-e', `do shell script "${literal}" with administrator privileges`];
    }
    return ['pkexec', cmd, ...args];
}
