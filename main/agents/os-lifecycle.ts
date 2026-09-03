import fs from 'node:fs';
import path from 'node:path';

const ORIENTED_MARKER = '.genie-osa-oriented';
export type OsAgentBootMode = 'first-boot' | 'recovery';

/**
 * Durable proof that this workstation has already been set up — the things a
 * missing `.genie-osa-oriented` cannot see (genie#352).
 *
 * ONE property decides what belongs here: a Reset Workstation clears it. That is
 * what keeps the positive control real — a machine that was genuinely made new
 * again still gets `first-boot`.
 *
 * That rule is also why the operator's own `.ai/memory` is NO LONGER evidence.
 * It used to be, while the envelope lived at `<userData>/genie-os.agi` and a
 * reset took it. The envelope moved to `~/.gosa`, deliberately outside the reset
 * boundary, so its notes now survive a wipe — which would make them proof that a
 * freshly-reset machine was configured. It is dropped for exactly the reason it
 * was added.
 *
 * Deliberately NOT here either: the managed toolchain. `workstation/reset.ts`
 * PRESERVES `toolchain/` (it holds live binaries other processes are running),
 * so an installed php would outlive the very reset that is supposed to make the
 * machine new.
 */
export interface WorkstationSetupEvidence {
    /** A project workspace exists. Read from the db, which a reset deletes. */
    hasWorkspace: boolean;
}

/** PURE. Whether the evidence says this machine has been through setup already. */
export function workstationIsConfigured(evidence: WorkstationSetupEvidence): boolean {
    return evidence.hasWorkspace;
}

/**
 * Gather the evidence. `hasWorkspace` comes from the caller because the
 * workspace list lives in the db, which this module deliberately does not reach
 * into.
 */
export function readWorkstationEvidence(hasWorkspace: boolean): WorkstationSetupEvidence {
    return { hasWorkspace };
}

/**
 * Which script the workstation operator is handed on this boot.
 *
 * The marker settles it when present. When it is ABSENT the evidence decides,
 * because a missing dotfile is indistinguishable from a genuinely new machine —
 * and for every version up to beta.296 it was ALWAYS absent: the only writer was
 * `thumbsUp(reason:'boot')`, gated on a `claude-channel` nothing ever bound
 * (genie#348). So an owner with workspaces, memory and a configured toolchain
 * was told, every single restart, that this was the first boot, and the operator
 * re-ran onboarding instead of resuming as the machine's operator.
 */
export function osAgentBootMode(
    userDataDir: string,
    evidence: WorkstationSetupEvidence,
): OsAgentBootMode {
    if (fs.existsSync(path.join(userDataDir, ORIENTED_MARKER))) return 'recovery';
    return workstationIsConfigured(evidence) ? 'recovery' : 'first-boot';
}

/**
 * Decide the boot mode AND make it durable.
 *
 * This is the "written on a successful boot" half of genie#352. The transport
 * gate on `thumbsUp(reason:'boot')` stays exactly as it was — an OSA still
 * cannot report setup complete with no working inbox — it simply is no longer
 * the ONLY thing that can ever record "this machine is not new". A machine with
 * no evidence is never marked, so a first boot stays a first boot.
 */
export function recordOsAgentBoot(
    userDataDir: string,
    evidence: WorkstationSetupEvidence,
): OsAgentBootMode {
    const mode = osAgentBootMode(userDataDir, evidence);
    if (mode === 'recovery') markOsAgentOriented(userDataDir);
    return mode;
}

export function markOsAgentOriented(userDataDir: string): void {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, ORIENTED_MARKER), new Date().toISOString(), {
        encoding: 'utf8', mode: 0o600,
    });
}

export function osAgentBootInstructions(mode: OsAgentBootMode): string {
    return mode === 'first-boot'
        ? 'This is the workstation first boot. Orient yourself, verify your native AgentInbox transport and Genie system services, then guide the owner through model provider, toolchain, Tynn, optional GitHub, Genie OS backup, and workspace setup. Only after those checks call thumbsUp with reason boot; that is the sole setup-complete signal.'
        : 'This is a workstation recovery boot. Reattach to and verify the Genie host services, native AgentInbox transport, managed toolchain, and prior Genie OS workspace and memory. Preserve existing configuration. Call thumbsUp with reason boot after recovery and orientation complete.';
}
