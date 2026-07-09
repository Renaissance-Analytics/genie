import { describe, expect, it } from 'vitest';
import {
    renderAgentLaunch,
    renderAgentResume,
    appendLaunchFlags,
    extractSessionId,
    transcriptDirFor,
    sessionIdFromTranscriptFile,
    pickNewSessionId,
    LAUNCH_PROFILES,
} from '../session-capture';

describe('renderAgentResume — graceful restart command (wish #88)', () => {
    const SID = 'abcd1234-5678-90ab-cdef-1234567890ab';

    it('builds a claude --resume command from the captured session id', () => {
        expect(renderAgentResume('claude', 'claude', SID)).toBe(`claude --resume ${SID}`);
    });

    it('strips an existing --session-id before adding --resume (no double-flag)', () => {
        expect(renderAgentResume('claude', `claude --session-id ${SID}`, SID)).toBe(
            `claude --resume ${SID}`,
        );
    });

    it('strips an existing --resume/--continue before rebuilding', () => {
        expect(renderAgentResume('claude', `claude --resume ${SID}`, SID)).toBe(
            `claude --resume ${SID}`,
        );
        expect(renderAgentResume('claude', `claude --continue ${SID}`, SID)).toBe(
            `claude --resume ${SID}`,
        );
    });

    it('preserves other flags around the session flag', () => {
        expect(renderAgentResume('claude', `claude --model opus --session-id ${SID}`, SID)).toBe(
            `claude --model opus --resume ${SID}`,
        );
    });

    it('falls back to the bare `claude` binary when the base command is empty', () => {
        expect(renderAgentResume('claude', '', SID)).toBe(`claude --resume ${SID}`);
    });

    it('refuses (null) with no captured session id — never a context-less restart', () => {
        expect(renderAgentResume('claude', 'claude', null)).toBeNull();
        expect(renderAgentResume('claude', 'claude', '')).toBeNull();
    });

    it('refuses (null) for non-claude agents (codex/custom resume unknown)', () => {
        expect(renderAgentResume('codex', 'codex', SID)).toBeNull();
        expect(renderAgentResume('custom', 'my-wrapper.sh', SID)).toBeNull();
    });
});

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

describe('appendLaunchFlags — always-on agent flags', () => {
    it('appends flags when set', () => {
        expect(appendLaunchFlags('claude', '--dangerously-skip-permissions')).toBe(
            'claude --dangerously-skip-permissions',
        );
    });

    it('is a no-op when the flags are empty or whitespace', () => {
        expect(appendLaunchFlags('claude', '')).toBe('claude');
        expect(appendLaunchFlags('claude', '   ')).toBe('claude');
        expect(appendLaunchFlags('claude', undefined)).toBe('claude');
    });

    it('trims both sides and preserves multiple flags', () => {
        expect(appendLaunchFlags('  my-agent  ', '  --a --b=1  ')).toBe('my-agent --a --b=1');
    });

    it('applies to any agent command (e.g. a custom agent)', () => {
        expect(appendLaunchFlags('my-cli run', '--browser')).toBe('my-cli run --browser');
    });
});

describe('always-on flags → session-id pipeline (appendLaunchFlags then renderAgentLaunch)', () => {
    it('injects the session-id AFTER the flags: <command> <flags> --session-id <uuid>', () => {
        const withFlags = appendLaunchFlags('claude', '--dangerously-skip-permissions');
        const r = renderAgentLaunch('claude', withFlags, () => 'sid-1');
        expect(r.command).toBe('claude --dangerously-skip-permissions --session-id sid-1');
        expect(r.chatSessionId).toBe('sid-1');
    });

    it('does NOT double --session-id when the flags already include one', () => {
        const existing = 'abcd1234-5678-90ab-cdef-1234567890ab';
        const withFlags = appendLaunchFlags('claude', `--session-id ${existing}`);
        const r = renderAgentLaunch('claude', withFlags, () => 'should-not-be-used');
        expect(r.command).toBe(`claude --session-id ${existing}`);
        expect(r.chatSessionId).toBe(existing);
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
