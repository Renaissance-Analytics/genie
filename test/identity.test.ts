import { describe, expect, it } from 'vitest';
import {
    AGENT_RECORD_FIELDS,
    agentRecord,
    mintAgentId,
    threadIdIsResumable,
    threadKeyFor,
    type AgentRecord,
} from '../src/core/identity.js';

/**
 * ONE KEY, MINTED ONCE, USED BY EVERYTHING.
 *
 * This is the defect that made the previous build's Conversation tab unreachable, and it is
 * worth being precise about why it was so expensive to find: **an identity split is
 * invisible**. Nothing throws. The session store happily writes under one id, the view
 * happily reads under another, and the UI renders a perfectly correct empty session forever.
 * Four releases shipped that way and every surface downstream was blamed first.
 *
 * So the guard is not "remember to use the same id". It is that there is exactly one
 * function that turns an agent into a storage key, and these tests pin that both halves —
 * the writer and the reader — go through it.
 */
describe('agent identity', () => {
    it('mints distinct ids', () => {
        const a = mintAgentId();
        const b = mintAgentId();

        expect(a).not.toBe(b);
        expect(a).toMatch(/^agent_[0-9a-f]{32}$/);
    });

    it('derives a thread key that is byte-identical for the same id', () => {
        const id = mintAgentId();

        // The writer's key and the reader's key are the same call. If this ever becomes two
        // call sites with two shapes, that is the bug — and it is the one that hides.
        expect(threadKeyFor(id)).toBe(threadKeyFor(id));
        expect(threadKeyFor(id)).toContain(id);
    });

    it('gives different agents different thread keys', () => {
        // POSITIVE CONTROL for the assertion above: a key function that returned a constant
        // would satisfy "identical for the same id" perfectly, and collapse every agent's
        // history into one thread.
        expect(threadKeyFor(mintAgentId())).not.toBe(threadKeyFor(mintAgentId()));
    });
});

describe('the agent record', () => {
    const rec: AgentRecord = agentRecord({
        id: mintAgentId(),
        workspaceId: 'ws_1',
        provider: 'claude',
        name: 'atlas',
        instructions: '.agents/atlas/AGENT.md',
    });

    it('carries NO command line, shell or args — at runtime', () => {
        /**
         * *"If an agent record has a field describing a command line, the design has
         * leaked."* It is not a style note. In the previous build every agent's stored
         * `agent_command` carried flags, a bare-command check on that string decided the
         * engine, and so all thirty of the owner's agents were routed to a pty while their
         * provider was ACP-capable the whole time. The field was the mechanism.
         */
        const forbidden = ['command', 'agentCommand', 'agent_command', 'shell', 'args', 'argv', 'launch', 'cmd'];
        const present = Object.keys(rec).filter((k) => forbidden.includes(k));

        expect(present).toEqual([]);
    });

    it('POSITIVE CONTROL: it carries the fields it is supposed to', () => {
        // Without this, "no command field" passes against an empty object — which is the way
        // an absence assertion fails quietly.
        expect(Object.keys(rec).sort()).toEqual([...AGENT_RECORD_FIELDS].sort());
        expect(rec.provider).toBe('claude');
        expect(rec.threadId).toBeNull();
    });

    it('starts with no thread, and that is NOT the same as an empty one', () => {
        // `null` = this agent has never run. An empty thread would claim it ran and said
        // nothing. The UI renders these differently and must be able to tell them apart.
        expect(rec.threadId).toBeNull();
        expect(rec.lastUsedAt).toBeNull();
    });
});

describe('a thread id is going to end up on a COMMAND LINE', () => {
    /**
     * `threadId` is persisted from the provider's own `cliSessionId` and handed back on
     * reattach as prism-acp's `resumeSessionId`. On Windows prism-acp spawns with
     * `shell: true` — it has to, because npm installs CLIs as `.cmd` shims and Node refuses to
     * spawn one otherwise (the CVE-2024-27980 fix) — and **cmd.exe interprets `&`, `|` and
     * `&&` inside ARGUMENTS, not only in the command**. The prism maintainer measured that:
     * an argument of `a&echo PWNED` executes `PWNED`.
     *
     * So this value round-trips through a JSON file on disk and then becomes a command-line
     * argument. Two ways something unwanted gets in:
     *
     *  - `agents.json` is editable by anything running as the user, and a value there is
     *    trusted today purely because Genie wrote it;
     *  - the id is **reported by the provider**, so a hostile or compromised provider server
     *    chooses it. That one is not a local-only story.
     *
     * prism-acp owns the quoting and is fixing it. This guard is Genie's own half, and it
     * stays after that lands: a value we pass to another process is ours to keep well-formed,
     * and defence in depth is the only kind that survives somebody else's refactor.
     *
     * An ALLOWLIST, not a blocklist of metacharacters. Shell quoting rules differ per shell
     * and per OS, and a blocklist is a bet that nobody will ever find a character you forgot.
     */
    it('accepts the shapes real providers actually report', () => {
        // Measured, not imagined: codex reported the first on this machine, the stub the
        // second. A guard that rejects a real session id breaks every resume.
        expect(threadIdIsResumable('01a12564-30a8-7961-8aa9-6d145dd2e179')).toBe(true);
        expect(threadIdIsResumable('stub_thread_0001')).toBe(true);
        expect(threadIdIsResumable('sess-ABC.123:7')).toBe(true);
    });

    it('refuses every shell metacharacter, counted rather than spot-checked', () => {
        /**
         * COUNTED, because a boolean on one sample passes while another gets through. The
         * only acceptable number of accepted hostile values is zero, and naming which ones
         * got through is what makes a failure here actionable.
         */
        const hostile = [
            'a&echo PWNED',
            'a|echo PIPED',
            'a&&echo CHAINED',
            'a;echo SEMI',
            'a$(echo SUB)',
            'a`echo TICK`',
            'a>out.txt',
            'a<in.txt',
            'a^b',
            'a%PATH%',
            'a!b!',
            'two words',
            'a"b',
            "a'b",
            'a\nb',
            'a\rb',
            'a\tb',
            '',
            '   ',
            'a'.repeat(201),
        ];

        const accepted = hostile.filter((value) => threadIdIsResumable(value));
        expect(accepted).toEqual([]);
    });

    it('a fresh agent has no thread id at all, which is not a malformed one', () => {
        // POSITIVE CONTROL for the caller's side of this: `null` means never run, and must
        // not be mistaken for a value that failed the guard. Collapsing the two would make
        // every new agent look broken.
        expect(agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' }).threadId)
            .toBeNull();
    });
});
