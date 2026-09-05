import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS, canResumeTui, providerDef } from '../../../main/agents/registry';
import { restartOptionsFor } from '../../../main/agents/restart-options';

/**
 * Who gets offered WHICH restart (genie#261 category C, then genie#443).
 *
 * The context menu gated the item on `spec.meta?.agent === 'claude'`, above a
 * comment asserting that "codex/custom have no resume in v1". Half of that was
 * never true: `renderAgentResume` has rendered a real `codex resume <id>`
 * command for as long as codex has been a provider, and `restartAgentTerminal`
 * performs it. So a codex agent was refused a restart that would have worked —
 * and the comment is why nobody looked, because a wrong comment defending wrong
 * behaviour reads as a decision rather than a bug.
 *
 * The fix was not `|| === 'codex'`. That is the same bug with one more literal,
 * and it would go stale again the next time a provider learns to resume. The
 * menu asks the registry, and `renderAgentResume` builds its command from that
 * same table — so the answer cannot drift from the command that gets run.
 *
 * genie#443 then found the OTHER half of it. Asking one question and using the
 * answer for both operations meant a provider with `resume: null` lost the
 * option ENTIRELY — including when its terminal was dead and there was no
 * conversation to protect. So the menu now asks `restartOptionsFor`, which
 * answers both questions separately, and offers a FRESH restart to every agent.
 *
 * SOURCE-LEVEL for the component half: this lane has no DOM harness (see
 * `vitest.config.ts`), and the precedent for pinning a menu's decisions off its
 * source is `spec-menu-language.test.ts` next door. It is deliberately the
 * WEAKER half — a rendered item proves nothing about whether the restart works,
 * which is what `main/mcp/__tests__/restart-fresh.test.ts` asserts on the pty.
 * What this pins is that the menu cannot drift from the registry again.
 */

const MENU = path.resolve(__dirname, '../../components/Master/SpecContextMenu.tsx');
const SRC = fs.readFileSync(MENU, 'utf8');

describe('the Restart agent items', () => {
    it('POSITIVE CONTROL: the source is actually read, and still has both gates', () => {
        // A missing file or a renamed constant would make every `not.toMatch`
        // below pass forever — the classic way a source-level test rots.
        expect(SRC.length).toBeGreaterThan(500);
        expect(SRC).toMatch(/restartOptions\.canResume/);
        expect(SRC).toMatch(/restartOptions\.canRestartFresh/);
    });

    it('derives both gates from the shared resolver, not from a provider literal', () => {
        expect(SRC).toMatch(/const restartOptions\s*=\s*restartOptionsFor\(/);
    });

    it('offers a FRESH restart to every agent — including one that cannot resume', () => {
        // The reported terminal: a Genie TUI dead at `bash: genie: command not
        // found`. It had no menu entry at all, so there was no way out of it
        // from the UI.
        for (const id of PROVIDER_IDS) {
            expect(restartOptionsFor({ meta: { agent: id } }).canRestartFresh, id).toBe(true);
        }
    });

    it('offers RESUME only where a resume genuinely exists', () => {
        // The positive control for the fix itself, and the guard against the
        // wrong one: a build that made resume "work everywhere" would silently
        // start a NEW conversation while the UI said it resumed (genie#440).
        const resumable = { meta: { agent: 'claude', chat_session_id: 'sess-1' } };
        expect(restartOptionsFor(resumable).canResume).toBe(true);
        expect(restartOptionsFor({ meta: { agent: 'codex', chat_session_id: 's' } }).canResume).toBe(true);
        expect(restartOptionsFor({ meta: { agent: 'custom', chat_session_id: 's' } }).canResume).toBe(false);
        expect(restartOptionsFor({ meta: { agent: 'kilo', chat_session_id: 's' } }).canResume).toBe(false);
        expect(restartOptionsFor({ meta: { agent: 'genie', chat_session_id: 's' } }).canResume).toBe(false);
    });

    it('answers for a provider string it does not know, without throwing', () => {
        // `meta.agent` is a stored string; a spec written by a newer build can
        // name a provider this one has never heard of.
        expect(canResumeTui('not-a-provider')).toBe(false);
        expect(canResumeTui(undefined)).toBe(false);
        expect(canResumeTui(null)).toBe(false);
        expect(restartOptionsFor({ meta: { agent: 'not-a-provider' } }).canRestartFresh).toBe(true);
    });

    it('covers every registered provider — none falls off the end of the table', () => {
        for (const id of PROVIDER_IDS) {
            expect(typeof canResumeTui(id), id).toBe('boolean');
            expect(providerDef(id).resume === null, id).toBe(!canResumeTui(id));
        }
    });

    it('no longer ASSERTS that codex cannot resume, or that fresh is unsafe to offer', () => {
        // The false claims the file carried, verbatim. They are pinned because
        // fixing one and leaving the other is exactly how a wrong comment
        // survives a sweep, and a wrong comment defending wrong behaviour is why
        // each of these bugs lasted.
        //
        // Narrow on purpose: the replacement comment RECOUNTS the old claims so
        // the next reader knows what not to put back. A guard broad enough to
        // forbid describing the bug would force the explanation out of the file.
        expect(SRC).not.toMatch(/codex\/custom have no resume/);
        expect(SRC).not.toMatch(/codex\/custom can't resume/);
        expect(SRC).not.toMatch(/Only a claude agent can be gracefully resumed/);
        expect(SRC).not.toMatch(/Only offered[\s*]*for a claude agent/);
        // …and the docblock says what decides it now, instead of naming one provider.
        expect(SRC).toMatch(/TuiDef\.resume/);
    });
});
