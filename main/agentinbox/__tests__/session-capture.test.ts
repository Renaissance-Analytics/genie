import { describe, expect, it } from 'vitest';
import {
    renderAgentLaunch,
    renderAgentResume,
    renderAgentContinue,
    agentRelaunchDecision,
    resolveRestartCommand,
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

    it('uses the codex resume subcommand and keeps config options before the session id', () => {
        expect(renderAgentResume('codex', 'codex', SID)).toBe(`codex resume ${SID}`);
        expect(renderAgentResume('codex', 'codex --yolo -c mcp_servers.genie.enabled=true', SID)).toBe(
            `codex resume --yolo -c mcp_servers.genie.enabled=true ${SID}`,
        );
    });

    it('refuses a session id containing shell syntax', () => {
        expect(renderAgentResume('codex', 'codex', 'safe; Remove-Item secrets')).toBeNull();
        expect(renderAgentResume('claude', 'claude', 'safe && whoami')).toBeNull();
    });

    it('refuses (null) only when the custom wrapper resume grammar is unknown', () => {
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

describe('renderAgentLaunch — post-launch agents', () => {
    it('codex binds through its SessionStart hook', () => {
        const r = renderAgentLaunch('codex', 'codex -c model_reasoning_effort="high"');
        expect(r.strategy).toBe('hook');
        expect(r.command).toBe('codex -c model_reasoning_effort="high"');
        expect(r.chatSessionId).toBeNull();
    });

    it('does not mistake codex -c config for a resume flag', () => {
        const r = renderAgentLaunch('codex', 'codex -c mcp_servers.genie.enabled=true');
        expect(r.strategy).toBe('hook');
        expect(r.command).toBe('codex -c mcp_servers.genie.enabled=true');
        expect(r.chatSessionId).toBeNull();
    });

    it('custom uses detect (no launch flag, resolved post-launch)', () => {
        const r = renderAgentLaunch('custom', 'my-agent --go');
        expect(r.strategy).toBe('detect');
        expect(r.command).toBe('my-agent --go');
        expect(r.chatSessionId).toBeNull();
    });

    it('the profile registry is exhaustive over the agent types', () => {
        expect(Object.keys(LAUNCH_PROFILES).sort()).toEqual(['claude', 'codex', 'custom', 'genie', 'kiwi']);
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

describe('agentRelaunchDecision — fresh vs continue on agent-terminal reattach', () => {
    const claude = (extra: Record<string, string> = {}) => ({
        meta: { agent: 'claude', agent_command: 'claude', ...extra },
    });

    it('no-ops on a WARM reattach (existing=true) — the agent is still running', () => {
        expect(agentRelaunchDecision(claude({ chat_session_id: 'abc' }), true)).toBeNull();
    });

    it('no-ops for a non-agent terminal (or a missing spec)', () => {
        expect(agentRelaunchDecision({ meta: {} }, false)).toBeNull();
        expect(agentRelaunchDecision(null, false)).toBeNull();
    });

    it('CONTINUES: a captured chat_session_id resumes the same conversation', () => {
        expect(agentRelaunchDecision(claude({ chat_session_id: 'sess-1' }), false)).toEqual({
            command: 'claude --resume sess-1',
        });
    });

    it('FRESH: no captured session → mints a new --session-id (and returns it to persist)', () => {
        const d = agentRelaunchDecision(claude(), false);
        expect(d?.command).toMatch(/^claude --session-id [0-9a-fA-F-]{8,}$/);
        expect(d?.newSessionId).toBeTruthy();
        expect(d?.command).toBe(`claude --session-id ${d?.newSessionId}`);
    });

    it('codex resumes the captured conversation through its resume subcommand', () => {
        expect(
            agentRelaunchDecision(
                { meta: { agent: 'codex', agent_command: 'codex', chat_session_id: 'x' } },
                false,
            ),
        ).toEqual({ command: 'codex resume x' });
    });

    it('does not apply Claude transcript verification to a Codex hook session id', () => {
        expect(
            agentRelaunchDecision(
                { meta: { agent: 'codex', agent_command: 'codex', chat_session_id: 'x' } },
                false,
                () => false,
            ),
        ).toEqual({ command: 'codex resume x' });
    });
});

describe('resolveRestartCommand — graceful restart, never a phantom --resume', () => {
    const claude = (extra: Record<string, string> = {}) => ({
        meta: { agent: 'claude', agent_command: 'claude', ...extra },
    });
    const exists = () => true;
    const missing = () => false;

    it('resumes by id when the transcript exists on disk', () => {
        expect(resolveRestartCommand(claude({ chat_session_id: 'sess-1' }), exists)).toEqual({
            command: 'claude --resume sess-1',
        });
    });

    it('falls back to --continue when the captured id has DRIFTED (no transcript)', () => {
        // THE FIX: restartAgentTerminal used to call renderAgentResume directly,
        // so a drifted id produced `claude --resume <phantom>` → "No conversation
        // found", which reads as lost work. Verifying on disk yields --continue.
        expect(resolveRestartCommand(claude({ chat_session_id: 'sess-gone' }), missing)).toEqual({
            command: 'claude --continue',
        });
    });

    it('REFUSES a claude agent with no captured session (would lose the chat)', () => {
        const r = resolveRestartCommand(claude(), exists);
        expect('error' in r).toBe(true);
    });

    it('resumes codex exactly when its hook captured a session id', () => {
        const r = resolveRestartCommand(
            { meta: { agent: 'codex', agent_command: 'codex', chat_session_id: 'x' } },
            exists,
        );
        expect(r).toEqual({ command: 'codex resume x' });
    });

    it('REFUSES a non-agent terminal', () => {
        expect('error' in resolveRestartCommand({ meta: {} }, exists)).toBe(true);
        expect('error' in resolveRestartCommand(null, exists)).toBe(true);
    });
});

describe('renderAgentContinue — most-recent fallback', () => {
    it('builds `claude --continue`, stripping any stale session/resume flag', () => {
        expect(renderAgentContinue('claude', 'claude')).toBe('claude --continue');
        expect(renderAgentContinue('claude', 'claude --resume abcd1234-5678-90ab')).toBe(
            'claude --continue',
        );
        expect(
            renderAgentContinue('claude', 'claude --model opus --session-id abcd1234-5678-90ab'),
        ).toBe('claude --model opus --continue');
    });

    it('refuses (null) when a provider has no most-recent fallback grammar', () => {
        expect(renderAgentContinue('codex', 'codex')).toBeNull();
        expect(renderAgentContinue('custom', 'my-wrapper.sh')).toBeNull();
    });
});

describe('agentRelaunchDecision — verify the captured id before --resume', () => {
    const claude = (extra: Record<string, string> = {}) => ({
        meta: { agent: 'claude', agent_command: 'claude', ...extra },
    });

    it('RESUMES by exact id when the transcript exists on disk', () => {
        expect(
            agentRelaunchDecision(claude({ chat_session_id: 'sess-1' }), false, () => true),
        ).toEqual({ command: 'claude --resume sess-1' });
    });

    it('CONTINUES (-c) instead of dead-ending when the captured id has NO transcript', () => {
        // The stored id drifted from the live chat (recovered via -c / regenerated).
        // `--resume <phantom>` would 404 "No conversation found" — continue instead.
        expect(
            agentRelaunchDecision(claude({ chat_session_id: 'phantom' }), false, () => false),
        ).toEqual({ command: 'claude --continue' });
    });

    it('a custom agent with a missing id falls through to a fresh launch (no -c)', () => {
        expect(
            agentRelaunchDecision(
                {
                    meta: {
                        agent: 'custom',
                        agent_command: 'my-wrapper',
                        chat_session_id: 'phantom',
                    },
                },
                false,
                () => false,
            ),
        ).toEqual({ command: 'my-wrapper' });
    });

    it('trusts the id when no verifier is passed (pre-verification behaviour preserved)', () => {
        expect(agentRelaunchDecision(claude({ chat_session_id: 'sess-1' }), false)).toEqual({
            command: 'claude --resume sess-1',
        });
    });
});
