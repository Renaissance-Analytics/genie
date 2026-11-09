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
    /** The shutdown already ran: let the quit proceed, do nothing twice. */
    | 'pass';

export interface QuitSequence {
    readonly quitting: boolean;
    /** The OS is ending the session (shutdown, restart, sign-out): no question is asked — nothing could answer it. Shuts everything down. */
    force(): void;
    /** The answer is already given (the tray's Shut down everything and Restart, the tray-only exit): the quit asks nothing. */
    choose(answer: 'shut-down'): void;
    /** An upgrade's drain recorded the running set itself; a later quit must not overwrite it with the empty set it leaves. */
    markRecorded(): void;
    beforeQuit(input: { readonly ready: boolean; readonly plan: () => QuitPlan; readonly ask: (plan: Extract<QuitPlan, { confirm: true }>) => QuitAnswer }): QuitStep;
}

export function quitSequence(): QuitSequence {
    let chosen: 'shut-down' | null = null;
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
    /** Every agent session stopped (in the host, or in this process on the emergency path). */
    stopAgents(): void;
    /** What this window process runs, and what it drives in the host (the supervised processes). */
    closeWindow(): void;
    /** Every terminal ended (§7.1). */
    closeTerminals(): void;
    /** The stops' writes landed (SessionHost.drained), bounded by the caller. */
    drained(): Promise<unknown>;
    /** The host ended gracefully (`engine.shutdown`). */
    shutDownHost(): Promise<unknown>;
}

/**
 * SHUT DOWN EVERYTHING: the graceful stop it always was — agents first, then this window's work and the terminals, the
 * writes drained, and only then the host ended (a drain that fails still ends it, so a quit is never left half done).
 */
export async function runQuit(ports: QuitPorts, options: { readonly drainMs?: number } = {}): Promise<void> {
    ports.stopAgents();
    ports.closeWindow();
    ports.closeTerminals();
    // The drain is bounded HERE, never by a race around the whole quit: that race once spent its bound on a slow drain and
    // the window exited before the host was told to end (ss-repeat5, 2026-11-05). The host's end has its own bound.
    let bound: ReturnType<typeof setTimeout> | undefined;
    const over = options.drainMs === undefined ? null : new Promise<void>((r) => { bound = setTimeout(r, options.drainMs); });
    await Promise.race([ports.drained().catch(() => undefined), ...(over ? [over] : [])]);
    clearTimeout(bound);
    await ports.shutDownHost();
}
