/**
 * A PROVIDER CLI UPDATE DRAINS FIRST (Tynn #1067; the owner, 2026-11-26: "when updating cli it should send a stop command to
 * all running agents like genie upgrade process"). Pure orchestration; genie-host supplies the ports.
 *
 * Updating Claude Code or Codex replaces the program every agent on that provider is executing: on Windows the file is
 * locked and the update fails, elsewhere a session is left half-replaced. So, as the host's own update does (P6-2,
 * core/agent-shutdown-drain.ts): every running agent of THAT provider is asked to finish its turn at a safe point (up to the
 * same 120 seconds), then stopped; the CLI is updated; then each is started again ONCE on its own conversation, and the
 * ones the stop cut mid-turn are told to carry on. Agents of other providers are never touched.
 *
 * - A stop that leaves a process running refuses the update — the old program is still held — and what was already
 *   stopped is started again. The reason names the agent.
 * - An update that fails (or throws) restores every agent too: the old CLI is what they run. The caller says why.
 * - Every step is a lifecycle-log line, in the order it happened.
 */

export interface CliDrainAgent {
    readonly id: string;
    readonly name: string;
    readonly provider: string;
    readonly running: boolean;
    readonly inTurn: boolean;
}

export type CliDrainStep = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface CliDrainPorts {
    readonly agents: () => readonly CliDrainAgent[];
    /** The host-update drain, for these agents only: resolves when each is at a safe point (or the wait ran out), with who was still mid-turn. */
    readonly waitForSafe: (ids: readonly string[]) => Promise<{ readonly interrupted: readonly string[] }>;
    /** Stop one agent and wait for its run to end; `ok: false` when a process of it is still running. */
    readonly stop: (id: string) => Promise<CliDrainStep>;
    /** Start one agent on its own conversation; `resume` = it was cut mid-turn and is told to carry on. */
    readonly start: (id: string, resume: boolean) => Promise<CliDrainStep>;
    readonly progress: (step: string) => void;
    readonly log: (line: string) => void;
}

export type CliDrainResult<T> =
    | { readonly kind: 'ran'; readonly outcome: T; readonly restarted: readonly string[]; readonly notRestarted: readonly { readonly name: string; readonly reason: string }[] }
    | { readonly kind: 'refused'; readonly reason: string; readonly restarted: readonly string[]; readonly notRestarted: readonly { readonly name: string; readonly reason: string }[] };

/** What an agent the drain cut mid-turn is told once it is back (as a Restart tells it, core/agent-ops.ts). */
export const resumeAfterCliUpdate = (label: string): string =>
    `Genie stopped you to update ${label} while you were in the middle of a turn, so that turn was cancelled. ` +
    'Genie has resumed this conversation. Continue the work you were doing, from where you left off. ' +
    'Check the state of anything you were changing before you carry on — the cancelled step may not have finished.';

const list = (names: readonly string[]): string => (names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const why = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Run `update` with `provider`'s running agents drained around it. `failed(outcome)` says, in words, why an outcome did not
 * take (`null` = it did), for the log; the outcome itself goes back to the caller either way.
 */
export async function drainedCliUpdate<T>(provider: string, label: string, ports: CliDrainPorts, update: () => Promise<T>, failed: (outcome: T) => string | null): Promise<CliDrainResult<T>> {
    const targets = ports.agents().filter((a) => a.provider === provider && a.running);
    if (targets.length === 0) return { kind: 'ran', outcome: await update(), restarted: [], notRestarted: [] };
    const tag = `cli drain provider=${provider}`;
    const names = targets.map((a) => a.name);
    const turns = targets.length === 1 ? 'its turn' : 'their turns';
    ports.log(`${tag} agents=${names.join(',')}: waiting for a safe point`);
    ports.progress(`Asking ${list(names)} to finish ${turns}`);
    let interrupted: ReadonlySet<string> = new Set();
    try {
        interrupted = new Set((await ports.waitForSafe(targets.map((a) => a.id))).interrupted);
    } catch { /* an unreadable wait is no reason to keep the update from its stop; nobody is told to resume */ }

    ports.progress(`Stopping ${list(names)}`);
    const stopped: CliDrainAgent[] = [];
    let refusal: string | null = null;
    for (const agent of targets) {
        let step: CliDrainStep;
        try { step = await ports.stop(agent.id); } catch (error) { step = { ok: false, reason: why(error) }; }
        if (!step.ok) { refusal = `${agent.name} did not stop (${step.reason})`; break; }
        stopped.push(agent);
    }

    const restore = async (): Promise<{ restarted: string[]; notRestarted: { name: string; reason: string }[] }> => {
        const restarted: string[] = [];
        const notRestarted: { name: string; reason: string }[] = [];
        if (stopped.length > 0) ports.progress(`Starting ${list(stopped.map((a) => a.name))} again`);
        for (const agent of stopped) {
            let step: CliDrainStep;
            try { step = await ports.start(agent.id, interrupted.has(agent.id)); } catch (error) { step = { ok: false, reason: why(error) }; }
            if (step.ok) restarted.push(agent.name);
            else notRestarted.push({ name: agent.name, reason: step.reason });
        }
        return { restarted, notRestarted };
    };
    const restoredLine = (r: { restarted: string[]; notRestarted: { name: string; reason: string }[] }): string =>
        `restarted=${r.restarted.join(',')}${r.notRestarted.length > 0 ? ` not-restarted=${r.notRestarted.map((n) => `${n.name} (${n.reason})`).join(',')}` : ''}`;

    if (refusal !== null) {
        const restored = await restore();
        ports.log(`${tag} refused: ${refusal.replace(/ \(.*$/, '')}; ${restoredLine(restored)}`);
        return { kind: 'refused', reason: `${refusal}, so ${label} was not updated`, ...restored };
    }

    const midTurn = stopped.filter((a) => interrupted.has(a.id)).map((a) => a.name);
    ports.log(`${tag} stopped=${stopped.map((a) => a.name).join(',')}${midTurn.length > 0 ? ` mid-turn=${midTurn.join(',')}` : ''}`);
    ports.progress(`Updating ${label}`);
    let outcome: T;
    try {
        outcome = await update();
    } catch (error) {
        ports.log(`${tag} update=failed: ${why(error)}`);
        const restored = await restore();
        ports.log(`${tag} ${restoredLine(restored)}`);
        throw error;
    }
    const failure = failed(outcome);
    ports.log(`${tag} update=${failure === null ? 'ok' : `failed: ${failure}`}`);
    const restored = await restore();
    ports.log(`${tag} ${restoredLine(restored)}`);
    return { kind: 'ran', outcome, ...restored };
}
