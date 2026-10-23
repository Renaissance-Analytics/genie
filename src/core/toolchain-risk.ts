/**
 * THE UPDATE-RISK GUARD (§6.6) — pure. "What would updating this tool walk into RIGHT NOW?"
 *
 * Genie 1's rules (toolchain-update-risk.ts, including its genie#448 lessons), on Genie 2's model:
 *
 * - **An agent CLI** (claude-code, codex): `npm install -g` overwrites the very executable a running session is
 *   executing — on Windows the write fails outright (the file is locked), elsewhere the session is left half-replaced.
 *   REFUSED, but only for the sessions running THAT CLI: a running Claude session says nothing about replacing Codex.
 * - **node**: every agent CLI and every node dev server Genie runs is executing ON it. REFUSED while any agent session
 *   or any Genie-run node process is up — the one place the blanket rule is the true one.
 * - **docker**: updating Docker Desktop restarts its engine, which stops every running service engine. WARNED, naming
 *   them; the person may go ahead.
 *
 * The answer NAMES what is busy, because a refusal that cannot say what it would break is a refusal people learn to
 * route around. And **installing a tool that is not there replaces nothing**: no rule applies to it (Genie 1's owner
 * could not install a missing CLI because two Claude agents were mid-turn).
 */

export interface ToolchainActivity {
    /** Agent sessions whose process is running, with the provider each runs (`claude`, `codex`). */
    readonly sessions: readonly { readonly label: string; readonly provider: string }[];
    /** Processes Genie runs (sites' dev servers and workers, kept background processes) that are up, with their command. */
    readonly processes: readonly { readonly label: string; readonly command: string }[];
    /** Service engines whose container is running, by name. */
    readonly engines: readonly string[];
}

export type UpdateRisk =
    | { readonly risk: 'safe' }
    | { readonly risk: 'blocked' | 'warn'; readonly reason: string; readonly affected: readonly string[] };

/** tool → the provider whose sessions execute it. */
const CLI_PROVIDER: Readonly<Record<string, { provider: string; label: string }>> = {
    'claude-code': { provider: 'claude', label: 'Claude Code' },
    codex: { provider: 'codex', label: 'Codex' },
};

/** The launchers that run ON node. A command's first word, without its directory, quotes or a Windows extension. */
const NODE_LAUNCHERS: ReadonlySet<string> = new Set(['node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'corepack', 'tsx', 'ts-node', 'nodemon', 'vite', 'next', 'nuxt', 'astro']);

export function runsOnNode(command: string): boolean {
    const first = command.trim().match(/^"([^"]+)"|^(\S+)/);
    const word = (first?.[1] ?? first?.[2] ?? '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
    return NODE_LAUNCHERS.has(word);
}

/** A command's first word, without its directory, quotes or a Windows extension. */
function firstWord(command: string): string {
    const first = command.trim().match(/^"([^"]+)"|^(\S+)/);
    return (first?.[1] ?? first?.[2] ?? '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/** Executes PHP: `php …` (artisan serve, a queue worker) or a `php-cgi` worker, by whatever path. */
export function runsOnPhp(command: string): boolean {
    const word = firstWord(command);
    return word === 'php' || word === 'php-cgi';
}

const list = (names: readonly string[]): string => (names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const are = (n: number) => (n === 1 ? 'is' : 'are');

export function updateRisk(tool: string, activity: ToolchainActivity, target: { readonly installed: boolean }): UpdateRisk {
    if (!target.installed) return { risk: 'safe' };

    const cli = CLI_PROVIDER[tool];
    if (cli) {
        const running = activity.sessions.filter((s) => s.provider === cli.provider).map((s) => s.label);
        if (running.length > 0) {
            return {
                risk: 'blocked',
                affected: running,
                reason: `${list(running)} ${are(running.length)} running on ${cli.label}. Updating it replaces the program ${running.length === 1 ? 'that session is' : 'those sessions are'} running — on Windows the update fails, elsewhere the session breaks mid-turn. Stop ${running.length === 1 ? 'it' : 'them'} first, then update.`,
            };
        }
        return { risk: 'safe' };
    }

    if (tool === 'node') {
        const busy = [...activity.sessions.map((s) => s.label), ...activity.processes.filter((p) => runsOnNode(p.command)).map((p) => p.label)];
        if (busy.length > 0) {
            return {
                risk: 'blocked',
                affected: busy,
                reason: `${list(busy)} ${are(busy.length)} running on Node right now. Updating Node pulls the runtime out from under ${busy.length === 1 ? 'it' : 'them'}. Stop ${busy.length === 1 ? 'it' : 'them'} first, then update.`,
            };
        }
        return { risk: 'safe' };
    }

    /*
     * PHP (PHP2Shell, 2026-10-22): Genie installs each PHP into its own directory, so an update overwrites no running
     * binary — never blocked. But the php-cgi pool, `artisan serve` and the queue workers keep EXECUTING the old PHP
     * until they are restarted, and a security update that leaves them on the old one has fixed nothing yet. Warned,
     * naming them, so the restart is part of the update and not a surprise found later.
     */
    if (tool === 'php') {
        const busy = activity.processes.filter((p) => runsOnPhp(p.command)).map((p) => p.label);
        if (busy.length > 0) {
            return {
                risk: 'warn',
                affected: busy,
                reason: `${list(busy)} ${are(busy.length)} running on PHP right now, and ${busy.length === 1 ? 'it keeps' : 'they keep'} running the old PHP until ${busy.length === 1 ? 'it is' : 'they are'} restarted. Restart ${busy.length === 1 ? 'it' : 'them'} after the update.`,
            };
        }
        return { risk: 'safe' };
    }

    if (tool === 'docker' && activity.engines.length > 0) {
        return {
            risk: 'warn',
            affected: [...activity.engines],
            reason: `Updating Docker restarts its engine, which stops ${list(activity.engines)}. Any site or workspace using ${activity.engines.length === 1 ? 'it' : 'them'} loses its database until ${activity.engines.length === 1 ? 'it starts' : 'they start'} again.`,
        };
    }

    return { risk: 'safe' };
}
