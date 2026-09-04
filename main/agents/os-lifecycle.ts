import fs from 'node:fs';
import path from 'node:path';
import { operatorRoleBrief } from './os-agent';

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

/**
 * The operator's opening turn — the ROLE first, then this boot's script.
 *
 * It used to be one sentence per mode, describing the task and nothing else. Two
 * things were wrong with that, and they compound:
 *
 *  1. **No boundary.** Neither string said what the operator must NOT do, so the
 *     agent responsible for the machine took on the work running on it. That is
 *     the owner's actual complaint, and {@link operatorRoleBrief} — carried in
 *     BOTH modes, because an operator on its ninth restart is exactly the one
 *     that starts picking up project work — is the answer to it.
 *
 *  2. **The two modes barely differed.** genie#352 fixed the DETECTION (the
 *     marker was never written before beta.296, so every restart claimed to be a
 *     first boot); it did not make the two scripts say different things. A
 *     recovery boot now refuses onboarding in as many words: do not ask for a
 *     model provider again, do not reinstall a toolchain that is present, do not
 *     create workspaces that already exist.
 *
 * Kept SHORT on purpose. This is delivered as one double-quoted argv element
 * typed into the TUI (`withProviderStartupInstructions`) — the long form is the
 * charter, which the harness loads as memory instead. That distinction is why
 * the AgentBuilder skill was removed from here: a file is instructions, 1.2KB
 * retyped into the terminal on every relaunch is noise.
 */
export function osAgentBootInstructions(mode: OsAgentBootMode): string {
    const thisBoot = mode === 'first-boot'
        ? [
              'THIS BOOT is the workstation FIRST BOOT: nothing is set up yet.',
              'Verify your native AgentInbox transport and the Genie system',
              'services, then guide the owner through model provider, toolchain,',
              'Tynn, optional GitHub, Genie OS backup, and workspace setup. Call',
              'thumbsUp with reason boot only after those checks pass; that is the',
              'sole setup-complete signal. Your operator charter is in AGENTS.md,',
              'and genieGuide with topic the-workstation-operator has the full',
              'protocol.',
          ]
        : [
              'THIS BOOT is a workstation RECOVERY boot: this machine is already',
              'set up, so do NOT re-run onboarding. Reattach to and verify what is',
              'already here: the Genie host services, your native AgentInbox',
              'transport, the managed toolchain, and the existing Genie OS',
              'workspace and memory. Do not ask the owner to choose a model',
              'provider again, do not reinstall a toolchain that is present, and',
              'do not create workspaces that already exist. Preserve existing',
              'configuration, change only what you find broken, and report what',
              'you verified. Call thumbsUp with reason boot after recovery and',
              'orientation are complete. Your operator charter is in AGENTS.md,',
              'and genieGuide with topic the-workstation-operator has the full',
              'protocol.',
          ];
    return `${operatorRoleBrief()} ${thisBoot.join(' ')}`;
}
