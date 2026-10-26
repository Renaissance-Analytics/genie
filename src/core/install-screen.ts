/**
 * THE RESTART SCREEN (genie#1201; the owner, 2026-10-26: "when I hit the 'restart genie to install..' button … the whole
 * Genie UI freezes, turns a pale white … We need a better UX during that time"). From the click until Genie is gone the
 * window shows one screen saying what is happening and what it waits for. The click shows it at once (`asked`), before
 * main has answered; main's progress (`installing`) fills it in. An install that failed is not a restart: no screen.
 */
export interface InstallScreenInput {
    readonly phase: string;
    readonly version: string | null;
    readonly installing?: { readonly step: 'agents' | 'processes' | 'restarting'; readonly agents: number; readonly left: number };
}

export interface InstallScreen {
    readonly title: string;
    readonly detail: string;
}

export function installScreen(state: InstallScreenInput | null, asked: boolean): InstallScreen | null {
    if (!state || state.phase === 'error') return null;
    if (state.phase !== 'installing' && !(asked && state.phase === 'downloaded')) return null;
    const title = `Restarting to install Genie${state.version ? ` ${state.version}` : ''}…`;
    const p = state.phase === 'installing' ? state.installing : undefined;
    if (!p) return { title, detail: 'Getting ready…' };
    if (p.step === 'agents') return { title, detail: p.agents > 0 ? `Stopping agents — ${p.left} of ${p.agents} still stopping` : 'Stopping agents' };
    if (p.step === 'processes') return { title, detail: 'Closing what runs from Genie’s install folder' };
    return { title, detail: 'Restarting…' };
}
