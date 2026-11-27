/**
 * QUIT CONFIRMATION (§6.5) — defaults to the SAFE thing. Nothing running → just quit. Agents or
 * terminals live → ask, name what ends, default Cancel. Live agents make Genie ask, because an agent
 * session ends with the app (§2.5) and nothing revives it on its own.
 *
 * WITH GENIE-HOST (the host split, P1b; the owner's decision 5): the agents, the terminals and the kept processes run in
 * the host, which can outlive this window. The quit then asks two answers — "Just close the UI" (the host keeps all of it
 * running, and the next window picks it up) or "Shut down everything" (today's graceful stop). Cancel stays the default.
 */

/** What the person answered: nothing, close only the window, or stop everything. */
export type QuitAnswer = 'cancel' | 'close-ui' | 'shut-down';

type Asking<B> = { confirm: true; defaultChoice: 'cancel'; title: string; message: string; buttons: B };
export type QuitPlan =
    | { confirm: false }
    | Asking<['Cancel', 'Quit']>
    | Asking<['Cancel', 'Just close the UI', 'Shut down everything']>;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

export function quitPlan(input: {
    runningAgents: readonly string[];
    liveTerminals: number;
    /** Set while a live genie-host runs the agents and can outlive this window; absent or null = this process is the host. */
    host?: { readonly keptProcesses: number; readonly armedFlows: number; readonly scheduledTasks: number } | null;
}): QuitPlan {
    const agents = input.runningAgents.length;
    if (input.host) return hostPlan(input.runningAgents, input.liveTerminals, input.host.keptProcesses, input.host.armedFlows, input.host.scheduledTasks);
    const terminalsEnd = input.liveTerminals;
    if (agents === 0 && terminalsEnd === 0) return { confirm: false };

    const parts: string[] = [];
    const ends: string[] = [];
    if (agents > 0) {
        parts.push(`${agents} ${plural(agents, 'agent is', 'agents are')} running (${input.runningAgents.join(', ')})`);
        ends.push(agents === 1 ? 'ends its session' : 'ends the agents’ sessions');
    }
    if (terminalsEnd > 0) {
        parts.push(`${terminalsEnd} ${plural(terminalsEnd, 'terminal is', 'terminals are')} open`);
        ends.push(terminalsEnd === 1 ? 'closes it' : 'closes the terminals');
    }
    const message = `${parts.join(' and ')}. Quitting ${ends.join(' and ')}.`;
    return { confirm: true, defaultChoice: 'cancel', title: 'Quit Genie?', message, buttons: ['Cancel', 'Quit'] };
}

/** The host keeps the agents, every terminal (the host owns them), the kept processes, and what waits on its clock. */
function hostPlan(runningAgents: readonly string[], terminals: number, processes: number, flows: number, tasks: number): QuitPlan {
    const agents = runningAgents.length;
    const total = agents + terminals + processes + flows + tasks;
    if (total === 0) return { confirm: false };
    const parts: string[] = [];
    const ends: string[] = [];
    if (agents > 0) {
        parts.push(`${agents} ${plural(agents, 'agent is', 'agents are')} running (${runningAgents.join(', ')})`);
        ends.push(agents === 1 ? 'ends its session' : 'ends the agents’ sessions');
    }
    if (terminals > 0) {
        parts.push(`${terminals} ${plural(terminals, 'terminal is', 'terminals are')} open`);
        ends.push(terminals === 1 ? 'closes it' : 'closes the terminals');
    }
    if (processes > 0) {
        parts.push(`${processes} kept ${plural(processes, 'process is', 'processes are')} running`);
        ends.push(processes === 1 ? 'stops it' : 'stops the processes');
    }
    if (flows > 0) {
        parts.push(`${flows} ${plural(flows, 'flow is', 'flows are')} armed`);
        ends.push(flows === 1 ? 'stops it firing' : 'stops the flows firing');
    }
    if (tasks > 0) {
        parts.push(`${tasks} ${plural(tasks, 'task is', 'tasks are')} scheduled`);
        ends.push(tasks === 1 ? 'stops it firing' : 'stops the tasks firing');
    }
    const one = total === 1;
    const message = `${listed(parts)}. Just close the UI and ${one ? 'it keeps' : 'they keep'} running, and Genie stays in the tray. Shut down everything ${listed(ends)}.`;
    return { confirm: true, defaultChoice: 'cancel', title: 'Quit Genie?', message, buttons: ['Cancel', 'Just close the UI', 'Shut down everything'] };
}

/** The dialog's button, as the answer. Button 0, an index off the list (Esc, the dialog closed) → Cancel. */
export function quitAnswer(plan: Extract<QuitPlan, { confirm: true }>, index: number): QuitAnswer {
    const label: string | undefined = index > 0 ? (plan.buttons as readonly string[])[index] : undefined;
    if (label === undefined) return 'cancel';
    return label === 'Just close the UI' ? 'close-ui' : 'shut-down';
}

/**
 * ONE QUIT, IN ORDER — the `before-quit` handler's decisions, held here so they can be counted.
 *
 * Electron emits `before-quit` once per `app.quit()`, and Genie calls `app.quit()` more than once
 * in a single quit: the first pass records who was running (§7.6) and resumes the quit when that
 * write lands. A second request can also arrive mid-way — the OS ending the session while the
 * write is in flight. Whatever the sequence, the person is asked at most once, the running set is
 * recorded at most once, and the shutdown (sessions, services, terminals) runs EXACTLY once.
 *
 * "Just close the UI" is NOT a quit (the owner, 2026-11-02: "Keep the tray up"): the windows close and this process stays as
 * the tray while genie-host runs anything (core/tray-only.ts). Nothing is recorded or confirmed, and a later quit asks again.
 *
 * `quitting` is what the main window's close reads (core/tray-resident.ts): until a quit is
 * confirmed, closing the window hides it; once confirmed, the close is real, or Electron would
 * abort the quit. A cancelled question leaves it false — the window keeps hiding.
 */
export type QuitStep =
    /** The person said Cancel: prevent this quit; nothing has changed. */
    | 'cancel'
    /** Record the running set, prevent this quit, and quit again when the write lands. */
    | 'record'
    /** Run the shutdown now and let the quit proceed. */
    | 'shut-down'
    /** "Just close the UI": prevent this quit and close the windows; the process stays as the tray. Nothing is confirmed. */
    | 'close-ui'
    /**
     * An install that changes only the window (P6-1, Tynn #1036): the window process exits, because the installer replaces
     * its files, and stops nothing of genie-host: no agent, no terminal, no host. Let the quit proceed.
     */
    | 'exit-window'
    /** The shutdown already ran: let the quit proceed, do nothing twice. */
    | 'pass';

export interface QuitSequence {
    readonly quitting: boolean;
    /** The OS is ending the session (shutdown, restart, sign-out): no question is asked — nothing could answer it. Shuts everything down. */
    force(): void;
    /**
     * The answer is already given (the tray's Shut down everything and Restart, the tray-only exit; an install's quit,
     * `installQuit`): the quit asks nothing.
     */
    choose(answer: 'shut-down' | 'exit-window'): void;
    /** An upgrade's drain recorded the running set itself; a later quit must not overwrite it with the empty set it leaves. */
    markRecorded(): void;
    beforeQuit(input: { readonly ready: boolean; readonly plan: () => QuitPlan; readonly ask: (plan: Extract<QuitPlan, { confirm: true }>) => QuitAnswer }): QuitStep;
}

export function quitSequence(): QuitSequence {
    let chosen: 'shut-down' | 'exit-window' | null = null;
    let forced = false;
    let recorded = false;
    let done = false;
    return {
        get quitting() { return chosen !== null; },
        force() { forced = true; chosen = 'shut-down'; },
        choose(answer) { if (!forced) chosen = answer; },
        markRecorded() { recorded = true; },
        beforeQuit({ ready, plan, ask }) {
            if (done) return 'pass';
            if (chosen === 'exit-window') {
                done = true;
                return 'exit-window';
            }
            if (chosen === null) {
                let answer: QuitAnswer = 'shut-down';
                if (ready) {
                    const p = plan();
                    if (p.confirm) answer = ask(p);
                }
                if (answer === 'cancel') return 'cancel';
                // Not a quit: the windows close, the process stays as the tray, and the next quit asks again.
                if (answer === 'close-ui') return 'close-ui';
                chosen = answer;
            }
            if (!recorded && ready) {
                recorded = true;
                return 'record';
            }
            done = true;
            return 'shut-down';
        },
    };
}

/** What each answer does, as ports: main.ts's real ones; a test's counted ones. */
export interface QuitPorts {
    /** Every agent session stopped, in genie-host (the window runs none). */
    stopAgents(): void;
    /** What this window process runs, and what it drives in the host (the supervised processes). */
    closeWindow(): void;
    /** The stops' writes landed (SessionHost.drained), bounded by the caller. */
    drained(): Promise<unknown>;
    /** The host ended gracefully (`engine.shutdown`). */
    shutDownHost(): Promise<unknown>;
}

/**
 * SHUT DOWN EVERYTHING: the graceful stop it always was — agents first, then this window's work, the writes drained, and
 * only then the host ended, which ends its terminals too (a drain that fails still ends it, so a quit is never left half
 * done).
 */
export async function runQuit(ports: QuitPorts, options: { readonly drainMs?: number } = {}): Promise<void> {
    ports.stopAgents();
    ports.closeWindow();
    // The terminals are genie-host's: it ends them in its own shutdown, below (§7.1; Tynn #953, 2g-2).
    // The drain is bounded HERE, never by a race around the whole quit: that race once spent its bound on a slow drain and
    // the window exited before the host was told to end (ss-repeat5, 2026-11-05). The host's end has its own bound.
    let bound: ReturnType<typeof setTimeout> | undefined;
    const over = options.drainMs === undefined ? null : new Promise<void>((r) => { bound = setTimeout(r, options.drainMs); });
    await Promise.race([ports.drained().catch(() => undefined), ...(over ? [over] : [])]);
    clearTimeout(bound);
    await ports.shutDownHost();
}

/**
 * HOW THE WINDOW QUITS FOR AN INSTALL GENIE-HOST RUNS (P6-1, Tynn #1036). Measured on Windows: a client-only update kept
 * nothing, because the window always quit with "Shut down everything", and genie-host logged "shutting down: a window
 * asked" before the installer ran. Only the window: it exits, and genie-host and its agents keep running. Anything else,
 * or a scope the window was never told: the shut-down it always was.
 */
export function installQuit(scope: import('./update-kind.js').UpdateScope | undefined): 'shut-down' | 'exit-window' {
    return scope?.kind === 'client-only' ? 'exit-window' : 'shut-down';
}

/** The window leaves for a client-only install: its own work closed, nothing of genie-host stopped. */
export function leaveForInstall(ports: Pick<QuitPorts, 'closeWindow'>): void {
    ports.closeWindow();
}

/** One call on the launcher's wire (main/launcher-control.ts callLauncher, bound to this client). */
export type LauncherCaller = (method: string, args?: readonly unknown[]) => Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string; readonly code?: string }>;

/** Who carried the answer out: the launcher, this window alone (no launcher: a dev run), or nobody (the launcher failed). */
export type QuitBy = { readonly by: 'launcher' } | { readonly by: 'window' } | { readonly by: 'failed'; readonly reason: string };

/**
 * THE QUIT ANSWERS UNDER THE LAUNCHER (Tynn #1058 L5; the spec's "Quit keeps today's two answers"). The launcher owns the
 * tray, so the answers are the launcher's to carry out:
 *  - "Just close the UI": `launcher.closeUi`, which closes every client window (this one too) and marks the host left
 *    running; the host and the tray keep running;
 *  - "Shut down everything": `launcher.shutDown`, the host's graceful stop waited for on its own progress (Tynn #1079: never
 *    a 5 s kill), then the launcher exits.
 * Only with no launcher at all (a development run) does this window shut the host down itself (`windowShutDown`).
 */
export async function quitThroughLauncher(_answer: 'close-ui' | 'shut-down', ports: { readonly call: LauncherCaller; readonly windowShutDown: () => Promise<unknown> }): Promise<QuitBy> {
    await ports.windowShutDown();
    return { by: 'window' };
}
