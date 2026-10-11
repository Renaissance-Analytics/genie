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
