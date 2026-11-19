import { relaunchPlan } from '../core/upgrade-drain.js';

/**
 * RESTORE AFTER A RELAUNCH OR UPGRADE (§7.6), the window's boot: the agents a quit or an upgrade recorded are started again,
 * spaced; those a shutdown cut off mid-turn are resumed and told to continue. In safe mode, nothing (main.ts calls this).
 *
 * KEPT UNTIL STARTED (Tynn #754): both lists stay saved, and each agent leaves them only once its start went through
 * (`started`). They used to be taken (read and cleared) before the first start, and the starts are 3 s apart: a shutdown
 * inside that window recorded only the agents already started. On the owner's beta.63 -> beta.64 upgrade that lost 25 of
 * 31. A start that fails leaves its agent saved for the next launch. Every restore, and every agent's outcome, is logged.
 */
export interface RelaunchRestorePorts {
    /** genie-host's safe mode (Tynn #386). */
    readonly safeMode: () => boolean;
    /** The lists the last shutdown recorded, read for this restore (Tynn #754). */
    readonly pending: () => Promise<{ readonly running: readonly string[]; readonly interrupted: readonly string[] }>;
    /** An agent's start went through: it leaves the saved lists (Tynn #754). */
    readonly started: (agentId: string) => Promise<void>;
    /** An agent's name, for the log. */
    readonly name?: (agentId: string) => string;
    /** Before any start: a provider a previous Genie left on an agent's session is ended (Tynn #796). */
    readonly beforeStart?: () => Promise<void>;
    readonly schedule: (fn: () => void, ms: number) => void;
    /** The start, and for a mid-turn agent (`resume`) the prompt to continue. Throws when the agent did not start. */
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
    const { running, interrupted } = await p.pending();
    await p.beforeStart?.();
    const plan = relaunchPlan({ runningAtQuit: running, interruptedAtQuit: interrupted });
    const name = (id: string) => p.name?.(id) ?? id;
    if (plan.length > 0) p.log?.(`restore: ${plan.length} agent${plan.length === 1 ? '' : 's'} (${plan.filter((s) => s.resume).length} mid-turn): ${plan.map((s) => name(s.agentId)).join(', ')}`);
    for (const { agentId, at, resume } of plan) {
        p.schedule(() => { void restoreOne(p, name(agentId), agentId, resume); }, at);
    }
    return 'restored';
}

/** One agent's start: logged either way; only a start that went through takes it off the saved lists. */
async function restoreOne(p: RelaunchRestorePorts, name: string, agentId: string, resume: boolean): Promise<void> {
    try {
        await p.start(agentId, resume);
    } catch (error) {
        p.log?.(`restore: ${name} could not start, kept for the next launch: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }
    p.log?.(`restore: ${name} started${resume ? ' (resumed)' : ''}`);
    try {
        await p.started(agentId);
    } catch (error) {
        p.log?.(`restore: ${name} started, and is still saved to start (${error instanceof Error ? error.message : String(error)})`);
    }
}
