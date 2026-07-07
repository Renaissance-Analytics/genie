import { describe, expect, it } from 'vitest';
import {
    renderAgentLaunch,
    extractSessionId,
    transcriptDirFor,
    sessionIdFromTranscriptFile,
    pickNewSessionId,
    LAUNCH_PROFILES,
} from '../session-capture';

describe('renderAgentLaunch — flag strategy (claude)', () => {
    it('appends --session-id with a minted uuid and reports it', () => {
        const r = renderAgentLaunch('claude', 'claude', () => 'uuid-123');
        expect(r.strategy).toBe('flag');
        expect(r.command).toBe('claude --session-id uuid-123');
        expect(r.chatSessionId).toBe('uuid-123');
    });

    it('is idempotent — a command that already pins --session-id is untouched', () => {
        const existing = 'abcd1234-5678-90ab-cdef-1234567890ab';
        const r = renderAgentLaunch(
            'claude',
            `claude --session-id ${existing}`,
            () => 'should-not-be-used',
        );
        expect(r.command).toBe(`claude --session-id ${existing}`);
        expect(r.chatSessionId).toBe(existing);
    });

    it('does not inject when the command is resuming a session', () => {
        const r = renderAgentLaunch('claude', 'claude --resume', () => 'nope');
        expect(r.command).toBe('claude --resume');
        expect(r.chatSessionId).toBeNull();
    });

    it('carries through extra flags around the injected one', () => {
        const r = renderAgentLaunch('claude', 'claude --model opus', () => 'sid');
        expect(r.command).toBe('claude --model opus --session-id sid');
        expect(r.chatSessionId).toBe('sid');
    });
});

describe('renderAgentLaunch — non-flag agents', () => {
    it('codex captures nothing (strategy none)', () => {
        const r = renderAgentLaunch('codex', 'codex');
        expect(r.strategy).toBe('none');
        expect(r.command).toBe('codex');
        expect(r.chatSessionId).toBeNull();
    });

    it('custom uses detect (no launch flag, resolved post-launch)', () => {
        const r = renderAgentLaunch('custom', 'my-agent --go');
        expect(r.strategy).toBe('detect');
        expect(r.command).toBe('my-agent --go');
        expect(r.chatSessionId).toBeNull();
    });

    it('the profile registry is exhaustive over the agent types', () => {
        expect(Object.keys(LAUNCH_PROFILES).sort()).toEqual(['claude', 'codex', 'custom']);
    });
});

describe('extractSessionId', () => {
    it('reads a space- or equals-delimited id, else null', () => {
        expect(extractSessionId('claude --session-id 11112222-3333')).toBe('11112222-3333');
        expect(extractSessionId('claude --session-id=aaaa-bbbb')).toBe('aaaa-bbbb');
        expect(extractSessionId('claude')).toBeNull();
    });
});

describe('transcript dir + filename parsing (detect)', () => {
    it("encodes a cwd the way Claude Code names its projects dir", () => {
        const dir = transcriptDirFor('C:\\_Projects\\tynn.ai', '/home/u');
        // Every non-alphanumeric run collapses to a dash: C:\_Projects\tynn.ai
        // → C---Projects-tynn-ai.
        expect(dir.replace(/\\/g, '/')).toBe('/home/u/.claude/projects/C---Projects-tynn-ai');
    });

    it('parses the session id from a transcript filename', () => {
        expect(sessionIdFromTranscriptFile('deadbeef-1234.jsonl')).toBe('deadbeef-1234');
        expect(sessionIdFromTranscriptFile('/a/b/deadbeef-1234.jsonl')).toBe('deadbeef-1234');
        expect(sessionIdFromTranscriptFile('notes.txt')).toBeNull();
    });

    it('picks the newest brand-new transcript, ignoring pre-existing ones', () => {
        const before = new Set(['old-1.jsonl']);
        const id = pickNewSessionId(
            [
                { name: 'old-1.jsonl', mtimeMs: 100 },
                { name: 'new-a.jsonl', mtimeMs: 200 },
                { name: 'new-b.jsonl', mtimeMs: 300 },
            ],
            before,
        );
        expect(id).toBe('new-b'); // newest of the fresh ones
    });

    it('returns null when nothing new appeared', () => {
        const before = new Set(['a.jsonl']);
        expect(pickNewSessionId([{ name: 'a.jsonl', mtimeMs: 1 }], before)).toBeNull();
    });
});
