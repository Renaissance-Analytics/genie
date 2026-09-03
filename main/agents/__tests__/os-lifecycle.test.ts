import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    markOsAgentOriented,
    osAgentBootMode,
    readWorkstationEvidence,
    recordOsAgentBoot,
} from '../os-lifecycle';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

const newRoot = (prefix: string): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
};

/** A machine with nothing on it — the shape a genuinely new workstation has. */
const NOTHING = { hasWorkspace: false, hasOsMemory: false } as const;

describe('Genie OSA lifecycle', () => {
    it('stays in first-boot setup until Genie records completed orientation', () => {
        const root = newRoot('genie-osa-life-');
        expect(osAgentBootMode(root, NOTHING)).toBe('first-boot');
        markOsAgentOriented(root);
        expect(osAgentBootMode(root, NOTHING)).toBe('recovery');
    });
});

/**
 * genie#352 — a missing dotfile is not evidence of a new machine.
 *
 * `.genie-osa-oriented` was written in exactly ONE place: `thumbsUp(reason:
 * 'boot')`, behind a transport gate that could not pass until #348. So the
 * marker was never written, and every restart handed the workstation operator
 * the first-boot script — "guide the owner through model provider, toolchain,
 * Tynn…" — on a machine that already had workspaces, memory and a toolchain.
 *
 * The mode is derived from evidence a Reset Workstation clears, so a genuinely
 * new machine still gets `first-boot`.
 */
describe('OSA boot mode is derived from evidence, not one dotfile (genie#352)', () => {
    it('a configured workstation with NO marker still boots into recovery', () => {
        const root = newRoot('genie-osa-evidence-');

        expect(osAgentBootMode(root, { hasWorkspace: true, hasOsMemory: false })).toBe('recovery');
    });

    it('POSITIVE CONTROL — a genuinely new machine still gets first-boot', () => {
        // Without this, "always recovery" passes the test above just as well.
        const root = newRoot('genie-osa-evidence-new-');

        expect(osAgentBootMode(root, NOTHING)).toBe('first-boot');
    });

    it('counts the operator’s own memory envelope as evidence', () => {
        const root = newRoot('genie-osa-evidence-mem-');

        expect(osAgentBootMode(root, { hasWorkspace: false, hasOsMemory: true })).toBe('recovery');
    });

    it('reads that evidence off disk — an OSA memory note is a prior run', () => {
        const root = newRoot('genie-osa-evidence-read-');
        const memory = path.join(root, 'genie-os.agi', '.ai', 'memory');
        fs.mkdirSync(memory, { recursive: true });

        // The empty envelope `ensureGenieOsWorkspace` creates on EVERY boot is
        // not evidence of anything; a note written into it is.
        expect(readWorkstationEvidence(root, false).hasOsMemory).toBe(false);
        fs.writeFileSync(path.join(memory, 'toolchain.md'), 'php 8.4 installed');
        expect(readWorkstationEvidence(root, false).hasOsMemory).toBe(true);
    });

    it('a Reset Workstation puts it back to first-boot, toolchain and all', () => {
        // `workstation/reset.ts` PRESERVES `toolchain/` and deletes everything
        // else in userData — so an installed toolchain is deliberately NOT
        // evidence: it outlives the reset that is supposed to make the machine
        // new again. The db (workspaces) and the OSA envelope (memory) do not.
        const root = newRoot('genie-osa-evidence-reset-');
        fs.mkdirSync(path.join(root, 'toolchain', 'php', '8.4'), { recursive: true });

        expect(readWorkstationEvidence(root, false)).toEqual(NOTHING);
        expect(osAgentBootMode(root, readWorkstationEvidence(root, false))).toBe('first-boot');
    });
});

/**
 * The second half of genie#352: the marker is written by a SUCCESSFUL BOOT, not
 * only by a gate that can refuse. `thumbsUp(reason:'boot')` keeps its transport
 * gate — an OSA still cannot report setup complete with no working inbox — but
 * it is no longer the only thing that can ever record "this machine is not new".
 */
describe('recording a boot makes the mode durable', () => {
    it('writes the marker when the evidence says the machine is configured', () => {
        const root = newRoot('genie-osa-record-');

        expect(recordOsAgentBoot(root, { hasWorkspace: true, hasOsMemory: false })).toBe('recovery');
        // Durable: the NEXT boot needs no evidence at all.
        expect(osAgentBootMode(root, NOTHING)).toBe('recovery');
    });

    it('POSITIVE CONTROL — a new machine is not marked, and boots as first-boot', () => {
        const root = newRoot('genie-osa-record-new-');

        expect(recordOsAgentBoot(root, NOTHING)).toBe('first-boot');
        expect(osAgentBootMode(root, NOTHING)).toBe('first-boot');
        expect(fs.existsSync(path.join(root, '.genie-osa-oriented'))).toBe(false);
    });
});
