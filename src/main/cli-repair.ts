import { planCliRepair } from '../core/cli-repair.js';
import { providerName, type ProviderHealth } from '../core/provider-health.js';
import { platformArgv, type Platform } from '../core/toolchain.js';
import type { EnvPort } from './toolchain-ops.js';

/**
 * A BROKEN AGENT CLI, REPAIRED BY GENIE ITSELF (Tynn #698 story 2) — the main-side half. Check it, plan from what the check
 * found (`core/cli-repair.ts`), run each step with its own limit and say it while it runs, stop at the first that fails, put
 * the installer's folder on Genie's PATH, and CHECK AGAIN: the result is what the CLI does afterwards, never an exit code.
 *
 * The runner is the caller's (`execFileRunner`: the spawn host, where a command's input is closed at once and its limit ends
 * what it started, spawn-exec.ts).
 */

export interface CliRepairPorts {
    readonly platform: NodeJS.Platform;
    /** Genie's own environment: the PATH the installer's folder is put on. */
    readonly env: EnvPort;
    readonly isFile: (path: string) => boolean;
    readonly run: (binary: string, args: readonly string[], options: { readonly timeoutMs: number }) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly streams?: { readonly stdout: string; readonly stderr: string } }>;
    /** Pick up the PATH an installer persisted (Windows: Machine + User). */
    readonly refreshPath: () => Promise<void>;
    /** The provider's health, measured now; `null` when it could not be measured. */
    readonly check: (provider: string) => Promise<ProviderHealth | null>;
    /** The step being run, in words; `null` when the repair is over. */
    readonly progress: (step: string | null) => void;
}

export type CliRepairOutcome =
    | { readonly kind: 'repaired'; readonly version: string | null; readonly signedIn: boolean | null; readonly words: string }
    | { readonly kind: 'failed'; readonly reason: string }
    | { readonly kind: 'refused'; readonly reason: string };

/** Where each vendor's installer puts its program (read from the installers: install.ps1 / install.sh). */
function installedProgram(provider: string, ports: Pick<CliRepairPorts, 'platform' | 'env'>): { readonly dir: string; readonly file: string } | null {
    const win = ports.platform === 'win32';
    const home = win ? ports.env.get('USERPROFILE') : ports.env.get('HOME');
    if (provider === 'claude' && home) return win ? { dir: `${home}\\.local\\bin`, file: `${home}\\.local\\bin\\claude.exe` } : { dir: `${home}/.local/bin`, file: `${home}/.local/bin/claude` };
    if (provider === 'codex') {
        if (win) { const local = ports.env.get('LOCALAPPDATA'); return local ? { dir: `${local}\\Programs\\OpenAI\\Codex\\bin`, file: `${local}\\Programs\\OpenAI\\Codex\\bin\\codex.exe` } : null; }
        const dir = ports.env.get('CODEX_INSTALL_DIR') ?? (home ? `${home}/.local/bin` : null);
        return dir ? { dir, file: `${dir}/codex` } : null;
    }
    return null;
}

/** The installer's folder at the front of Genie's PATH when the program is there and the folder is not on it yet. */
export function putOnPath(provider: string, ports: Pick<CliRepairPorts, 'platform' | 'env' | 'isFile'>): void {
    const at = installedProgram(provider, ports);
    if (at === null || !ports.isFile(at.file)) return;
    const win = ports.platform === 'win32';
    const sep = win ? ';' : ':';
    const path = ports.env.get('PATH') ?? '';
    const same = (a: string) => (win ? a.replace(/[\\/]+$/, '').toLowerCase() === at.dir.toLowerCase() : a.replace(/\/+$/, '') === at.dir);
    if (path.split(sep).some(same)) return;
    ports.env.set('PATH', path ? `${at.dir}${sep}${path}` : at.dir);
}

const lastLine = (text: string): string => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 200) ?? '';

/** Repair one provider's CLI. Never throws; the progress always ends with `null`. */
export async function runCliRepair(provider: string, ports: CliRepairPorts): Promise<CliRepairOutcome> {
    const name = providerName(provider);
    try {
        ports.progress(`Checking ${name}`);
        const before = await ports.check(provider);
        if (before === null) return { kind: 'failed', reason: `${name} could not be checked, so Genie did not change anything` };
        const steps = planCliRepair({ provider, platform: ports.platform as Platform, health: before });
        if (!Array.isArray(steps)) return { kind: 'refused', reason: steps.refused };
        const lookup = { platform: ports.platform, env: { PATH: ports.env.get('PATH') ?? '', PATHEXT: ports.env.get('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD' } as NodeJS.ProcessEnv, isFile: ports.isFile };
        for (const step of steps) {
            ports.progress(step.label);
            const [binary, args] = platformArgv(step.binary, step.args, ports.platform as Platform, lookup);
            try {
                const r = await ports.run(binary, args, { timeoutMs: step.timeoutMs });
                if (r.exitCode !== 0) {
                    const said = lastLine(r.streams ? `${r.streams.stdout}\n${r.streams.stderr}` : r.stdout) || lastLine(r.stdout);
                    return { kind: 'failed', reason: `${step.label} failed (it exited ${r.exitCode})${said ? `: “${said}”` : ''}` };
                }
            } catch (error) {
                const code = (error as { code?: unknown } | null)?.code;
                if (code === 'ETIMEDOUT') return { kind: 'failed', reason: `${step.label} did not finish within ${Math.round(step.timeoutMs / 60_000)} minutes, and was ended with what it started` };
                return { kind: 'failed', reason: `${step.label} could not run: ${error instanceof Error ? error.message : String(error)}` };
            }
        }
        await ports.refreshPath();
        putOnPath(provider, ports);
        ports.progress(`Checking that ${provider} answers`);
        const after = await ports.check(provider);
        if (after === null) return { kind: 'failed', reason: `The steps ran, but ${name} could not be checked afterwards; the result is unknown` };
        if (!after.installed) return { kind: 'failed', reason: `The steps ran, but ${after.words ?? `${name} still does not run`}` };
        const signedOut = after.signedIn === false ? ` It is not signed in: Log in to ${name}.` : '';
        return { kind: 'repaired', version: after.version, signedIn: after.signedIn, words: `${name}${after.version ? ` ${after.version}` : ''} is installed and answers.${signedOut}` };
    } finally {
        ports.progress(null);
    }
}
