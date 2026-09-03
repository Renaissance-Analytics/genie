import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS, canResumeTui, providerDef } from '../../../main/agents/registry';

/**
 * Who gets offered "Restart agent" (genie#261, category C).
 *
 * The context menu gated the item on `spec.meta?.agent === 'claude'`, above a
 * comment asserting that "codex/custom have no resume in v1". Half of that was
 * never true: `renderAgentResume` has rendered a real `codex resume <id>`
 * command for as long as codex has been a provider, and `restartAgentTerminal`
 * performs it. So a codex agent was refused a restart that would have worked —
 * and the comment is why nobody looked, because a wrong comment defending wrong
 * behaviour reads as a decision rather than a bug.
 *
 * The fix is not `|| === 'codex'`. That is the same bug with one more literal,
 * and it would go stale again the next time a provider learns to resume. The
 * menu now asks the registry, and `renderAgentResume` builds its command from
 * that same table — so the answer cannot drift from the command that gets run.
 *
 * SOURCE-LEVEL for the component half: this lane has no DOM harness (see
 * `vitest.config.ts`), and the precedent for pinning a menu's decisions off its
 * source is `spec-menu-language.test.ts` next door.
 */

const MENU = path.resolve(__dirname, '../../components/Master/SpecContextMenu.tsx');
const SRC = fs.readFileSync(MENU, 'utf8');

describe('the Restart agent item', () => {
    it('POSITIVE CONTROL: the source is actually read, and still has the gate', () => {
        // A missing file or a renamed constant would make every `not.toMatch`
        // below pass forever — the classic way a source-level test rots.
        expect(SRC.length).toBeGreaterThan(500);
        expect(SRC).toMatch(/const isResumableAgent\s*=/);
    });

    it('is offered to a CODEX agent, whose restart works', () => {
        // The bug, stated as the user meets it: right-click a codex agent, and
        // "Restart agent" is not there.
        expect(canResumeTui('codex')).toBe(true);
    });

    it('is still offered to a CLAUDE agent', () => {
        // The positive control for the fix itself. A predicate that returned
        // true for everything would satisfy the codex case above on its own.
        expect(canResumeTui('claude')).toBe(true);
    });

    it('is still WITHHELD from a custom agent, and from kiwi and genie', () => {
        // These have no known resume grammar, so a restart would drop the
        // conversation into a fresh, context-less session. Offering a button
        // that loses work is worse than not offering one.
        expect(canResumeTui('custom')).toBe(false);
        expect(canResumeTui('kiwi')).toBe(false);
        expect(canResumeTui('genie')).toBe(false);
    });

    it('answers for a provider string it does not know, without throwing', () => {
        // `meta.agent` is a stored string; a spec written by a newer build can
        // name a provider this one has never heard of.
        expect(canResumeTui('gemini')).toBe(false);
        expect(canResumeTui(undefined)).toBe(false);
        expect(canResumeTui(null)).toBe(false);
    });

    it('covers every registered provider — none falls off the end of the table', () => {
        for (const id of PROVIDER_IDS) {
            expect(typeof canResumeTui(id), id).toBe('boolean');
            expect(providerDef(id).resume === null, id).toBe(!canResumeTui(id));
        }
    });

    it('derives the menu gate from the registry, not from a provider literal', () => {
        expect(SRC).toMatch(/const isResumableAgent\s*=\s*canResumeTui\(/);
    });

    it('no longer ASSERTS that codex cannot resume', () => {
        // Both false claims the file carried, verbatim — one on the gate, one in
        // the prop's docblock. They are pinned separately because fixing one and
        // leaving the other is exactly how a wrong comment survives a sweep, and
        // a wrong comment defending wrong behaviour is why this bug lasted.
        //
        // Narrow on purpose: the replacement comment RECOUNTS the old claim
        // ("under a comment claiming codex had no resume") so the next reader
        // knows what not to put back. A guard broad enough to forbid describing
        // the bug would force the explanation out of the file.
        expect(SRC).not.toMatch(/codex\/custom have no resume/);
        expect(SRC).not.toMatch(/codex\/custom can't resume/);
        expect(SRC).not.toMatch(/Only a claude agent can be gracefully resumed/);
        expect(SRC).not.toMatch(/Only offered[\s*]*for a claude agent/);
        // …and the docblock says what decides it now, instead of naming one provider.
        expect(SRC).toMatch(/TuiDef\.resume/);
    });
});
