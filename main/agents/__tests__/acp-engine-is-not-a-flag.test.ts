import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { engineFor } from '../engine';

/**
 * ACP IS NOT OPTIONAL — pinned, because a stale comment claiming otherwise cost a day.
 *
 * `agents/engine.ts` removed the global flag on a direct owner directive: *"acp is the core of our
 * agent communications, this is not optional."* A provider that can speak ACP speaks it.
 *
 * ## The failure this exists to prevent, which already happened
 *
 * `main/db.ts`'s comment on `acp_engine` went on saying **"`engineFor` reads this"** long after
 * `engineFor` stopped. Nothing failed, because a comment is not executable — and it was read as
 * authoritative. The consequences, all from that one sentence:
 *
 *  - A Settings switch was built and shipped for a setting **nothing consults**, offering to turn
 *    OFF the thing the owner had directed was not optional. A control that lies in both directions:
 *    it does nothing when used, and implies a capability that does not exist.
 *  - Two user-facing claims shipped in the release notes — *"Sending and approving needs ACP
 *    switched on"* and *"Agents still run in a pty unless you opt in to ACP"* — both false.
 *  - The release was reported as blocked on an owner decision **the owner had already made, in the
 *    opposite direction**, and a ForceTheQuestion was sent asking for it.
 *
 * **A comment asserting that code reads a value is a claim about behaviour, and nothing checks it.**
 * This is the check. It is cheap, and the thing it guards is the difference between "the engine is
 * off" and "the engine has been on for days".
 */

describe('engineFor routes on CAPABILITY, with no global flag', () => {
    it('gives an ACP-capable provider the ACP engine', () => {
        expect(engineFor({ provider: 'claude' })).toBe('acp');
    });

    it('holds a provider with no ACP mode on the pty', () => {
        // Capability is checked FIRST: forcing one would spawn something that is not an ACP server
        // and hang in the handshake, which reads as a wedged agent.
        // `null` = cannot run as an agent. This returned 'pty', which is what routed these
        // to a terminal instead of refusing.
        expect(engineFor({ provider: 'aider' })).toBeNull();
        expect(engineFor({ provider: null })).toBeNull();
    });

    it('cannot be overridden back onto a terminal', () => {
        // Holding an agent back used to mean pinning it to the pty. Agents do not run in
        // terminals, so there is nothing to pin it to: a capable provider is ACP.
        expect(engineFor({ provider: 'claude', agentOverride: 'acp' })).toBe('acp');
    });

    it('an override cannot CONJURE ACP for a provider that has none', () => {
        // The asymmetry worth pinning: an override is a preference, not a capability.
        expect(engineFor({ provider: 'aider', agentOverride: 'acp' })).toBeNull();
    });
});

describe('the dead setting stays dead', () => {
    const read = (rel: string) =>
        readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8').replace(/\r\n/g, '\n');

    it('engineFor does not consult acp_engine', () => {
        // The assertion that would have prevented all of it. If someone re-introduces the flag,
        // this fails and they have to confront the owner directive in the header above it rather
        // than discovering it afterwards.
        expect(read('main/agents/engine.ts')).not.toContain('acp_engine');
    });

    it('NOTHING in main reads it, not just engineFor', () => {
        // Scoped wider than the one function, because the comment that misled named `engineFor`
        // specifically and the real question was whether ANY reader existed.
        const readers = ['main/agents/launch-plan.ts', 'main/terminal/ipc.ts', 'main/acp/agent-spec.ts'];
        for (const f of readers) {
            const src = read(f);
            // A mention inside a comment is allowed — history is worth keeping. A settings READ is not.
            expect(src, f).not.toMatch(/settings[^\n]*\.acp_engine|acp_engine\s*===/);
        }
    });

    it('db.ts no longer declares the key AT ALL', () => {
        /**
         * Owner's choice, asked directly: *"Delete the dead column entirely."* So the assertion moves
         * from *the comment says nothing reads it* to *the key does not exist* — which is a stronger
         * guarantee and needs no prose to stay true.
         *
         * Migration v80 removes the stored ROW as well, following v25's precedent for retired
         * toggles: a key-value row that outlives its reader is exactly what let a stale comment about
         * it stay believable for as long as it did.
         *
         * The earlier version of this test asserted the ABSENCE of one sentence and failed against the
         * fixed file, because the correction quoted the old claim as history. Asserting the key's
         * absence has no such ambiguity: there is nothing to quote.
         */
        expect(read('main/db.ts')).not.toContain("acp_engine?:");
    });

    it('the migration that drops the stored row is present', () => {
        // Removing the type without the row would leave the value in every existing profile, where a
        // remote settings payload or a diagnostic could resurrect it as apparent product state.
        const src = read('main/db.ts');
        expect(src).toContain("DELETE FROM settings WHERE key = 'acp_engine'");
        expect(src).toContain('version: 80,');
    });

    it('positive control: the guard reads the real files', () => {
        expect(read('main/agents/engine.ts')).toContain('export function engineFor');
        // A marker that SURVIVES the deletion. This line used to assert `acp_engine?:` was present,
        // which was right while the key existed and became false the moment it was removed — a
        // positive control must not be anchored on the very thing under test.
        expect(read('main/db.ts')).toContain('export function getAllSettings');
    });
});
