import { relaunchPlan } from '../core/upgrade-drain.js';

/**
 * RESTORE AFTER A RELAUNCH OR UPGRADE (§7.6), the window's boot: the agents a quit or an upgrade recorded are started again,
 * spaced; those a shutdown cut off mid-turn are resumed and told to continue. Both lists are TAKEN (read once and
 * cleared), so a crash mid-restore starts nobody twice. In safe mode, nothing (main.ts calls this; the test spies on it).
 */
export interface RelaunchRestorePorts {
    /** genie-host's safe mode (Tynn #386). */
    readonly safeMode: () => boolean;
    readonly takeRunningAtQuit: () => Promise<readonly string[]>;
    readonly takeInterruptedAtQuit: () => Promise<readonly string[]>;
    /** Before any start: a provider a previous Genie left on an agent's session is ended (Tynn #796). */
    readonly beforeStart?: () => Promise<void>;
    readonly schedule: (fn: () => void, ms: number) => void;
    /** The start, and for a mid-turn agent (`resume`) the prompt to continue. */
    readonly start: (agentId: string, resume: boolean) => Promise<void>;
    readonly log?: (line: string) => void;
}

export async function restoreAfterRelaunch(p: RelaunchRestorePorts): Promise<'held' | 'restored'> {
    // SAFE MODE (Tynn #386): nobody is started or resumed, and both lists are KEPT — never taken — for the banner, and for
    // whatever the person starts from it. A provider a previous Genie left running is still ended.
    if (p.safeMode()) {
        await p.beforeStart?.();
        p.log?.('safe mode: the agents running at quit, and those cut off mid-turn, are kept and not started');
        return 'held';
    }
    const [running, interrupted] = await Promise.all([p.takeRunningAtQuit(), p.takeInterruptedAtQuit()]);
    await p.beforeStart?.();
    for (const { agentId, at, resume } of relaunchPlan({ runningAtQuit: running, interruptedAtQuit: interrupted })) {
        p.schedule(() => { void p.start(agentId, resume); }, at);
    }
    return 'restored';
}
