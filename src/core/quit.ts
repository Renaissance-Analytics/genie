/**
 * QUIT CONFIRMATION (§6.5) — defaults to the SAFE thing. Nothing running → just quit. Agents or
 * terminals live → ask, name what ends, default Cancel. With detached terminals on, the terminals
 * survive the quit and the message says so; live agents still make Genie ask, because an agent
 * session ends with the app (§2.5) and nothing revives it on its own.
 */

export type QuitPlan =
    | { confirm: false }
    | { confirm: true; defaultChoice: 'cancel'; title: string; message: string; buttons: ['Cancel', 'Quit'] };

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function quitPlan(input: { runningAgents: readonly string[]; liveTerminals: number; detachedTerminals: boolean }): QuitPlan {
    const agents = input.runningAgents.length;
    const terminalsEnd = input.detachedTerminals ? 0 : input.liveTerminals;
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
    let message = `${parts.join(' and ')}. Quitting ${ends.join(' and ')}.`;
    if (input.detachedTerminals && input.liveTerminals > 0) {
        message = `${parts.join(' and ')}. Quitting ${ends.join(' and ')}; the ${input.liveTerminals} open ${plural(input.liveTerminals, 'terminal keeps', 'terminals keep')} running detached and ${plural(input.liveTerminals, 'rejoins', 'rejoin')} next launch.`;
    }
    return { confirm: true, defaultChoice: 'cancel', title: 'Quit Genie?', message, buttons: ['Cancel', 'Quit'] };
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
    /** The shutdown already ran: let the quit proceed, do nothing twice. */
    | 'pass';

export interface QuitSequence {
    readonly quitting: boolean;
    /** The OS is ending the session (shutdown, restart, sign-out): no question is asked — nothing could answer it. */
    force(): void;
    /** An upgrade's drain recorded the running set itself; a later quit must not overwrite it with the empty set it leaves. */
    markRecorded(): void;
    beforeQuit(input: { readonly ready: boolean; readonly plan: () => QuitPlan; readonly ask: (plan: Extract<QuitPlan, { confirm: true }>) => boolean }): QuitStep;
}

export function quitSequence(): QuitSequence {
    let confirmed = false;
    let recorded = false;
    let shutDown = false;
    return {
        get quitting() { return confirmed; },
        force() { confirmed = true; },
        markRecorded() { recorded = true; },
        beforeQuit({ ready, plan, ask }) {
            if (!confirmed && ready) {
                const p = plan();
                if (p.confirm && !ask(p)) return 'cancel';
            }
            confirmed = true;
            if (!recorded && ready) {
                recorded = true;
                return 'record';
            }
            if (shutDown) return 'pass';
            shutDown = true;
            return 'shut-down';
        },
    };
}
