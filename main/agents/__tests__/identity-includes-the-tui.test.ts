import { describe, expect, it } from 'vitest';
import { agentRef, parseAgentRef, savedAgentKey } from '../identity';

/**
 * AN AGENT'S REF CARRIES ITS TUI. Its saved-config KEY does not.
 *
 * ★ This file used to be `identity-is-not-the-tui.test.ts` and asserted the
 * opposite. Read the reversal rather than trusting either half from memory.
 *
 * It was right for the schema it was written against: v55 collapsed
 * `UNIQUE (workspace_id, tui, name)` to `UNIQUE (workspace_id, name)`, so
 * `ddece5f7` took the tui out of both the key and the ref. **v60 put it back a
 * day later** — `idx_workspace_agents_tui_name` is UNIQUE on
 * `(workspace_id, tui, name)`, because the owner's rule is that `codex:tynn` and
 * `claude:tynn` are two agents (genie#324). The index moved; the ref did not,
 * and this file went on asserting the abandoned model. Nothing failed, because
 * nothing tested the ref against the schema that had replaced it.
 *
 * What that cost is genie#388: `list` published a bare name while
 * `agentinbox/address.ts` only recognised a tui-headed tag, so the one field an
 * agent could read was the one field it could not use. Three agents hit it
 * independently.
 *
 * The two halves are deliberately different things, and that is the distinction
 * this file now pins:
 *
 *   - the REF is an ADDRESS — `{tui}:{name}[:{chat-id}]`, what `list` prints and
 *     `send` takes, and what the identity index keys on;
 *   - the SAVED-CONFIG KEY is the NAME alone, because it has to resolve BEFORE a
 *     harness runs (Codex cannot know its session id until it is running) and
 *     because a saved agent is the same saved agent under either driver.
 */

describe('savedAgentKey', () => {
    it('is the NAME — the tui is not part of it', () => {
        expect(savedAgentKey('tynn')).toBe('tynn');
    });

    it('normalises the name, so one agent cannot have two keys', () => {
        expect(savedAgentKey('  Tynn  ')).toBe(savedAgentKey('tynn'));
    });
});

describe('agentRef', () => {
    it('names the TUI, because identity does (v60)', () => {
        expect(agentRef({ tui: 'claude', name: 'tynn', chatSessionId: null })).toBe('claude:tynn');
    });

    it('distinguishes the two agents the schema distinguishes', () => {
        // `UNIQUE (workspace_id, tui, name)`: these are two rows, so they must
        // not be one address. Emitting the same ref for both is what let a DM
        // resolve to whichever sorted first.
        const onClaude = agentRef({ tui: 'claude', name: 'tynn', chatSessionId: 'c1' });
        const onCodex = agentRef({ tui: 'codex', name: 'tynn', chatSessionId: 'c1' });
        expect(onCodex).not.toBe(onClaude);
    });

    it('carries the chat session last, as addressing', () => {
        expect(agentRef({ tui: 'claude', name: 'tynn', chatSessionId: 'c1' })).toBe(
            'claude:tynn:c1',
        );
    });

    it('degrades to `{tui}:{name}` before a chat id exists', () => {
        // Codex spends its whole startup in this state; a ref with a blank tail
        // would read as "this agent's chat is called nothing".
        expect(agentRef({ tui: 'codex', name: 'tynn', chatSessionId: null })).toBe('codex:tynn');
    });

    it('falls back to the bare name when the tui is not known', () => {
        // `parseAgentRef` returns no tui for a legacy bare ref, and that value
        // round-trips back through here. Emitting `undefined:tynn` would be a
        // ref that names a driver called "undefined".
        const parsed = parseAgentRef('tynn')!;
        expect(agentRef(parsed)).toBe('tynn');
    });

    it('round-trips through parseAgentRef', () => {
        for (const identity of [
            { tui: 'claude' as const, name: 'tynn', chatSessionId: null },
            { tui: 'codex' as const, name: 'tynn', chatSessionId: 'c1' },
        ]) {
            expect(parseAgentRef(agentRef(identity))).toMatchObject(identity);
        }
    });
});

describe('parseAgentRef', () => {
    it('reads the canonical form', () => {
        expect(parseAgentRef('claude:tynn:c1')).toMatchObject({
            tui: 'claude',
            name: 'tynn',
            chatSessionId: 'c1',
        });
        expect(parseAgentRef('codex:tynn')).toMatchObject({ tui: 'codex', name: 'tynn' });
    });

    it('still reads a BARE ref, which is what was printed in between', () => {
        // Agents were told this shape for as long as it was emitted and have it
        // written down. Reading one has to keep working.
        expect(parseAgentRef('tynn:c1')).toMatchObject({ name: 'tynn', chatSessionId: 'c1' });
        expect(parseAgentRef('tynn')).toMatchObject({ name: 'tynn', chatSessionId: null });
    });

    it('does not treat an agent NAMED like a tui as a tui', () => {
        // An agent may legitimately be called `codex`. The tui reading only wins
        // when something follows it, so a bare `codex` is the NAME.
        expect(parseAgentRef('codex')).toMatchObject({ name: 'codex', chatSessionId: null });
    });

    it('rejects junk', () => {
        expect(parseAgentRef('')).toBeNull();
        expect(parseAgentRef('   ')).toBeNull();
    });
});
