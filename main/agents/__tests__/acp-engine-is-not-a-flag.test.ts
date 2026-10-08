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
        expect(engineFor({ provider: 'aider' })).toBe('pty');
        expect(engineFor({ provider: null })).toBe('pty');
    });

    it('honours a PER-AGENT override, which is the supported way to hold one back', () => {
        // One agent pinned to the pty for a reason is a per-agent fact. This is what replaced the
        // global flag, and it is what to reach for instead of reviving one.
        expect(engineFor({ provider: 'claude', agentOverride: 'pty' })).toBe('pty');
    });

    it('an override cannot CONJURE ACP for a provider that has none', () => {
        // The asymmetry worth pinning: an override is a preference, not a capability.
        expect(engineFor({ provider: 'aider', agentOverride: 'acp' })).toBe('pty');
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

    it('db.ts marks the key VESTIGIAL rather than claiming a reader', () => {
        /**
         * Asserted POSITIVELY, and the first draft of this test got it wrong in an instructive way.
         *
         * It asserted the absence of the stale sentence — `not.toContain('`engineFor` reads this')` —
         * and promptly failed against the FIXED file, because the correction quotes the old claim as
         * history before refuting it. A substring guard cannot tell an assertion from a quotation,
         * and this codebase quotes its own mistakes on purpose; banning the words would forbid the
         * documentation that stops the mistake recurring.
         *
         * Loosening the assertion to get green would have been the bandaid. Asserting the property
         * actually wanted — that the comment says nothing reads it — is the fix.
         */
        const src = read('main/db.ts');
        const block = src.slice(src.indexOf('acp_engine?:') - 1600, src.indexOf('acp_engine?:'));
        expect(block).toContain('VESTIGIAL');
        expect(block.toLowerCase()).toContain('nothing reads this');
    });

    it('positive control: the guard reads the real files', () => {
        expect(read('main/agents/engine.ts')).toContain('export function engineFor');
        expect(read('main/db.ts')).toContain('acp_engine?:');
    });
});
