import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostsFilePath } from '../core/front-door-caddy.js';
import type { HostsIo } from './hosts-file.js';

/**
 * ELEVATION, PER OS — the two things the external-browser path needs root/administrator for: writing
 * the hosts file and installing Genie's CA into the trust store. Each OS has ONE prompt of its own and
 * Genie goes through it: UAC via `Start-Process -Verb RunAs`, macOS's administrator-privileges dialog
 * via `osascript`, polkit via `pkexec`. Never a stored password, never a shell string built from user
 * input: every argument is quoted so a path with a space or an apostrophe arrives as one token. A
 * declined prompt is an error carrying the tool's own words, and a step that ran and FAILED is an
 * error carrying its exit code (on Windows that code has to be carried back explicitly — see
 * elevationPlan) — each reported once, never retried into a prompt loop, never read as success.
 *
 * ONE PROMPT PER MOMENT (Genie 1's genie#604). Elevation is charged per launcher, not per command, so when the trust
 * install and a hosts write are due together they run as ONE batch under ONE prompt (elevationBatchPlan). A batch has
 * to stay legible when it fails, which shapes the scripts: Windows hands back nothing but the elevated process's exit
 * code (its console is its own), so the script exits PRIVILEGED_STEP_EXIT_BASE + the failing step's index; the unix
 * script also prints a marker on stderr, because osascript flattens every failure to exit 1 while passing stderr back
 * in its error text. Between the two, a batched failure still names the step that failed. And the Elevator runs one
 * batch at a time: two prompts are never on the screen at once.
 */

export interface Step {
    readonly command: string;
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>> | undefined;
}

/** A step in a batch, with what it is for: a failure is reported BY NAME, never as "something elevated failed". */
export interface PrivilegedStep {
    /** Stable id — `'trust'`, `'hosts'`. */
    readonly id: string;
    /** What it does, as the person reads it: "install Genie’s certificate into the trust store". */
    readonly label: string;
    readonly step: Step;
}

/**
 * What a batch came to. `failed` is the step it stopped at — the steps before it ran, the ones after it did not — or
 * `null` when the elevation itself failed (the prompt declined, the launcher missing) and so no step ran.
 */
export type ElevationOutcome = { ok: true } | { ok: false; failed: { id: string; label: string } | null; error: string };

/** What actually gets spawned (unelevated) to raise the OS prompt. */
export interface Plan {
    readonly command: string;
    readonly args: readonly string[];
}

export type ElevationRunner = (plan: Plan) => Promise<{ exitCode: number; stdout: string }>;

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const appleScriptString = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export function elevationPlan(platform: NodeJS.Platform, step: Step): Plan {
    const env = Object.entries(step.env ?? {});
    if (platform === 'win32') {
        // The elevated child inherits the launcher's environment, so env is set on the launcher.
        // Each argument is its own double-quoted token on the child's command line.
        const setEnv = env.map(([k, v]) => `$env:${k}=${psQuote(v)}; `).join('');
        const list = step.args.map((a) => psQuote(`"${a}"`)).join(',');
        // -PassThru + `exit $p.ExitCode` carry the ELEVATED process's exit code back: `Start-Process -Wait` alone returns
        // nothing, so the launcher exited 0 however the elevated step fared and a failed certutil read as trusted
        // (Genie 1 learned this as genie#609). Stop makes a dismissed UAC prompt a terminating error (exit 1, its words
        // on stderr), and no process object is a failure too — never a success.
        return {
            command: 'powershell',
            args: ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${setEnv}$p = Start-Process -Wait -PassThru -Verb RunAs -FilePath ${psQuote(step.command)}${list ? ` -ArgumentList @(${list})` : ''}; if ($null -eq $p) { exit 1 }; exit $p.ExitCode`],
        };
    }
    if (platform === 'darwin') {
        const line = [...env.map(([k, v]) => `${k}=${shQuote(v)}`), shQuote(step.command), ...step.args.map(shQuote)].join(' ');
        return { command: 'osascript', args: ['-e', `do shell script "${appleScriptString(line)}" with administrator privileges`] };
    }
    return { command: 'pkexec', args: [...(env.length > 0 ? ['env', ...env.map(([k, v]) => `${k}=${v}`)] : []), step.command, ...step.args] };
}

/** Exit code of a batch whose step `i` failed: BASE + i — above what commands commonly return, below pkexec's own 126/127. */
export const PRIVILEGED_STEP_EXIT_BASE = 90;
/** A guard, not a budget (two steps is the most anything batches): indices past this would collide with pkexec's codes. */
export const MAX_PRIVILEGED_STEPS = 30;

/** The stderr marker the unix batch prints before it gives up at step `i` — the channel osascript leaves open. */
export const privilegedStepMarker = (index: number): string => `genie-privileged-step:${index}`;
const STEP_MARKER = /genie-privileged-step:(\d+)/;

/**
 * The plan that runs every step, in order, under ONE prompt; the first step that fails ends the batch with
 * PRIVILEGED_STEP_EXIT_BASE + its index. The generated strings are asserted verbatim in test/elevate.test.ts.
 */
export function elevationBatchPlan(platform: NodeJS.Platform, steps: readonly Step[]): Plan {
    if (steps.length === 0) throw new Error('refusing to raise an elevation prompt for no steps');
    if (steps.length > MAX_PRIVILEGED_STEPS) throw new Error(`at most ${MAX_PRIVILEGED_STEPS} steps run under one elevation`);
    if (platform === 'win32') {
        // The elevated side is a PowerShell script handed over as base64 UTF-16LE (-EncodedCommand), which keeps every
        // path's quotes off three nested command lines (ours, Start-Process's -ArgumentList join, the child's own parse).
        const script = [
            ...steps.flatMap((s, i) => [
                ...Object.entries(s.env ?? {}).map(([k, v]) => `$env:${k}=${psQuote(v)}`),
                `& ${psQuote(s.command)}${s.args.map((a) => ` ${psQuote(a)}`).join('')}`,
                `if ($LASTEXITCODE -ne 0) { exit ${PRIVILEGED_STEP_EXIT_BASE + i} }`,
            ]),
            'exit 0',
        ].join('\n');
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        return {
            command: 'powershell',
            args: ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $p = Start-Process -Wait -PassThru -Verb RunAs -FilePath 'powershell' -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'); if ($null -eq $p) { exit 1 }; exit $p.ExitCode`],
        };
    }
    // Both unix platforms run the same /bin/sh script; only the wrapper differs.
    const script = steps
        .map((s, i) => {
            const line = [...(Object.keys(s.env ?? {}).length > 0 ? ['env', ...Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`)] : []), s.command, ...s.args].map(shQuote).join(' ');
            return `${line} || { echo ${shQuote(privilegedStepMarker(i))} >&2; exit ${PRIVILEGED_STEP_EXIT_BASE + i}; }`;
        })
        .join('; ');
    if (platform === 'darwin') return { command: 'osascript', args: ['-e', `do shell script "${appleScriptString(script)}" with administrator privileges`] };
    return { command: 'pkexec', args: ['/bin/sh', '-c', script] };
}

/** Copy the prepared file over the hosts file — the one elevated step the hosts sync needs. */
export function hostsWriteStep(platform: NodeJS.Platform, tmpFile: string, hostsPath: string): Step {
    if (platform === 'win32') {
        return { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', `Copy-Item -LiteralPath ${psQuote(tmpFile)} -Destination ${psQuote(hostsPath)} -Force`] };
    }
    return { command: 'cp', args: [tmpFile, hostsPath] };
}

/** An exit code as the OS means it: a Windows HRESULT (certutil's 0x80070005 = access denied) in hex, a small code as is. */
export function exitCodeText(code: number): string {
    return code < 0 || code > 255 ? `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}` : String(code);
}

export async function runElevated(platform: NodeJS.Platform, step: Step, run: ElevationRunner): Promise<void> {
    const r = await run(elevationPlan(platform, step));
    if (r.exitCode !== 0) throw new Error(r.stdout.trim() || `${step.command} ${step.args.join(' ')}: the elevated run failed (exit ${exitCodeText(r.exitCode)})`);
}

/**
 * Run a batch through ONE prompt and say which step stopped it: the stderr marker where the platform passes it back,
 * else the step-indexed exit code, else no step (the launcher or the prompt itself failed, so nothing ran and nothing
 * may be blamed). The message is the tool's own words, our marker stripped; or, with none, the exit code.
 */
export async function runElevatedBatch(platform: NodeJS.Platform, steps: readonly PrivilegedStep[], run: ElevationRunner): Promise<ElevationOutcome> {
    if (steps.length === 0) return { ok: true };
    const r = await run(elevationBatchPlan(platform, steps.map((s) => s.step)));
    if (r.exitCode === 0) return { ok: true };
    const marked = STEP_MARKER.exec(r.stdout);
    const index = marked ? Number(marked[1]) : r.exitCode - PRIVILEGED_STEP_EXIT_BASE;
    const failed = index >= 0 && index < steps.length ? steps[index]! : null;
    const words = r.stdout.split(/\r?\n/).map((l) => l.replace(STEP_MARKER, '').trim()).filter((l) => l !== '').join('\n');
    const error = words || (failed ? `${failed.label} failed` : `the elevated run failed (exit ${exitCodeText(r.exitCode)})`);
    return { ok: false, failed: failed ? { id: failed.id, label: failed.label } : null, error };
}

/**
 * ONE PROMPT AT A TIME. Every elevation goes through here, one batch after the other: a hosts write and a Trust that
 * arrive together are never two prompts stacked on the screen. An empty batch raises nothing.
 */
export class Elevator {
    readonly #run: (steps: readonly PrivilegedStep[]) => Promise<ElevationOutcome>;
    #chain: Promise<unknown> = Promise.resolve();

    constructor(run: (steps: readonly PrivilegedStep[]) => Promise<ElevationOutcome>) {
        this.#run = run;
    }

    run(steps: readonly PrivilegedStep[]): Promise<ElevationOutcome> {
        const next = this.#chain.then(async (): Promise<ElevationOutcome> => {
            if (steps.length === 0) return { ok: true };
            try {
                return await this.#run(steps);
            } catch (error) {
                // A launcher that could not even be spawned: nothing ran.
                return { ok: false, failed: null, error: error instanceof Error ? error.message : String(error) };
            }
        });
        this.#chain = next.catch(() => undefined);
        return next;
    }
}

/** What one step of a batch came to: ran, failed itself, or did not run because the batch stopped before it. */
export function stepOutcome(outcome: ElevationOutcome, steps: readonly PrivilegedStep[], id: string): { ok: true } | { ok: false; error: string } {
    if (outcome.ok) return { ok: true };
    if (outcome.failed === null) return { ok: false, error: outcome.error };
    if (outcome.failed.id === id) return { ok: false, error: outcome.error };
    const failedAt = steps.findIndex((s) => s.id === outcome.failed!.id);
    const mine = steps.findIndex((s) => s.id === id);
    if (mine >= 0 && mine < failedAt) return { ok: true };
    return { ok: false, error: `not done: ${outcome.failed.label} failed first in the same prompt (${outcome.error})` };
}

/** The hosts file on disk: plain reads and writes, and a staged `hosts.next` whose elevated copy runs in a batch. */
export function realHostsIo(deps: { platform: NodeJS.Platform; tmpDir: string; hostsPath?: string }): HostsIo {
    const hostsPath = deps.hostsPath ?? hostsFilePath(deps.platform);
    const tmp = join(deps.tmpDir, 'hosts.next');
    return {
        read: async () => {
            try {
                return await readFile(hostsPath, 'utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
                throw error;
            }
        },
        write: (content) => writeFile(hostsPath, content, 'utf8'),
        stage: async (content) => {
            await writeFile(tmp, content, 'utf8');
            return hostsWriteStep(deps.platform, tmp, hostsPath);
        },
    };
}
