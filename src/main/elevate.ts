import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostsFilePath } from '../core/front-door-caddy.js';
import type { HostsIo } from './hosts-file.js';

/**
 * ELEVATION, PER OS — the two things the external-browser path needs root/administrator for: writing
 * the hosts file and `caddy trust`. Each OS has ONE prompt of its own and Genie goes through it:
 * UAC via `Start-Process -Verb RunAs`, macOS's administrator-privileges dialog via `osascript`,
 * polkit via `pkexec`. Never a stored password, never a shell string built from user input: every
 * argument is quoted so a path with a space or an apostrophe arrives as one token. A declined prompt
 * is an error carrying the tool's own words — reported once, never retried into a prompt loop.
 */

export interface Step {
    readonly command: string;
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>> | undefined;
}

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
        return { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', `${setEnv}Start-Process -Wait -Verb RunAs -FilePath ${psQuote(step.command)} -ArgumentList @(${list})`] };
    }
    if (platform === 'darwin') {
        const line = [...env.map(([k, v]) => `${k}=${shQuote(v)}`), shQuote(step.command), ...step.args.map(shQuote)].join(' ');
        return { command: 'osascript', args: ['-e', `do shell script "${appleScriptString(line)}" with administrator privileges`] };
    }
    return { command: 'pkexec', args: [...(env.length > 0 ? ['env', ...env.map(([k, v]) => `${k}=${v}`)] : []), step.command, ...step.args] };
}

/** Copy the prepared file over the hosts file — the one elevated step the hosts sync needs. */
export function hostsWriteStep(platform: NodeJS.Platform, tmpFile: string, hostsPath: string): Step {
    if (platform === 'win32') {
        return { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', `Copy-Item -LiteralPath ${psQuote(tmpFile)} -Destination ${psQuote(hostsPath)} -Force`] };
    }
    return { command: 'cp', args: [tmpFile, hostsPath] };
}

export async function runElevated(platform: NodeJS.Platform, step: Step, run: ElevationRunner): Promise<void> {
    const r = await run(elevationPlan(platform, step));
    if (r.exitCode !== 0) throw new Error(r.stdout.trim() || `${step.command} ${step.args.join(' ')}: the elevated run failed (exit ${r.exitCode})`);
}

/** The hosts file on disk: plain reads and writes, and an elevated write via a prepared `hosts.next`. */
export function realHostsIo(deps: { platform: NodeJS.Platform; tmpDir: string; run: ElevationRunner; hostsPath?: string }): HostsIo {
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
        writeElevated: async (content) => {
            await writeFile(tmp, content, 'utf8');
            await runElevated(deps.platform, hostsWriteStep(deps.platform, tmp, hostsPath), deps.run);
        },
    };
}
