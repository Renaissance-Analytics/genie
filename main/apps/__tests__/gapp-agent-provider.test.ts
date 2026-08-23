import path from 'path';
import { describe, expect, it } from 'vitest';
import {
    GAPP_PROVIDERS,
    gappPersonaPath,
    resolveGappProvider,
    withPersonaBriefing,
} from '../agent-provider';

/**
 * WHICH TUI a GApp's declared agents launch under, and how the persona reaches it
 * (genie#245).
 *
 * The rule the owner set is the whole point of this module: the provider is a
 * WORKSTATION setting the user owns, never the GApp's choice. A GApp says it needs
 * an agent; the workstation decides what that agent IS. Same reasoning as the
 * agent-terminal cap — the app is asking for someone else's compute and someone
 * else's subscription, so it does not get to pick.
 */

describe('which TUI a GApp agent launches under', () => {
    it('uses the workstation GApp AI Provider when one is set', () => {
        expect(resolveGappProvider({ gapp_ai_provider: 'codex' })).toBe('codex');
    });

    it('falls back to the agent the user already made their default', () => {
        // Not a new question asked twice. The setup wizard already asked "which
        // agent do you use", so an unset provider inherits that answer rather than
        // making the user configure the same thing in two places.
        expect(resolveGappProvider({ agent_default: 'codex' })).toBe('codex');
    });

    it('prefers the explicit provider over the wizard default', () => {
        expect(resolveGappProvider({ gapp_ai_provider: 'claude', agent_default: 'codex' })).toBe(
            'claude',
        );
    });

    it('lands on claude when nothing is configured at all', () => {
        // A real answer, never `null`: an unresolvable provider means a declared
        // agent silently does not launch, which is the exact bug this fixes.
        expect(resolveGappProvider({})).toBe('claude');
    });

    it('ignores a value that is not an agent Genie can launch', () => {
        // These are strings out of a k/v table, so "cannot happen" is not on the
        // table. A junk value falls THROUGH to the next level rather than being
        // handed to a shell.
        expect(resolveGappProvider({ gapp_ai_provider: 'rm -rf /', agent_default: 'codex' })).toBe(
            'codex',
        );
        expect([...GAPP_PROVIDERS]).toEqual(['claude', 'codex', 'custom']);
    });
});

describe('where a declared persona actually lives', () => {
    it('resolves under the workspace .agents/ folder', () => {
        expect(gappPersonaPath(path.join('w', 'trader'), 'strategist.md')).toBe(
            path.join('w', 'trader', '.agents', 'strategist.md'),
        );
    });

    it('keeps a nested persona nested', () => {
        expect(gappPersonaPath(path.join('w', 'trader'), 'reviewer/persona.md')).toBe(
            path.join('w', 'trader', '.agents', 'reviewer', 'persona.md'),
        );
    });
});

describe('handing the persona to the TUI', () => {
    it('briefs the agent with the persona path, so it is not a bare shell', () => {
        const cmd = withPersonaBriefing(
            'claude --dangerously-skip-permissions',
            '/w/t/.agents/s.md',
            'Strategist',
        );
        expect(cmd.startsWith('claude --dangerously-skip-permissions ')).toBe(true);
        expect(cmd).toContain('/w/t/.agents/s.md');
        expect(cmd).toContain('Strategist');
    });

    it('quotes the briefing, so a workspace path with spaces still launches', () => {
        const cmd = withPersonaBriefing('claude', 'C:/My Apps/t/.agents/s.md', 'Strategist');
        // Everything after the command is ONE argument. A path with a space that
        // arrived as two words would make the TUI open with a truncated prompt and
        // an unrelated second positional — silently the wrong agent.
        const rest = cmd.slice('claude '.length);
        expect(rest.startsWith('"')).toBe(true);
        expect(rest.endsWith('"')).toBe(true);
        expect(rest.slice(1, -1)).not.toContain('"');
    });

    it('refuses to smuggle a quote out of the briefing', () => {
        // The name comes from a manifest and the path from a folder on disk, so
        // neither is trusted to be quote-free — a `"` that survived would close the
        // argument and turn the rest of the briefing into shell words.
        const cmd = withPersonaBriefing('claude', 'C:/a"b/.agents/s.md', 'He said "hi"');
        expect(cmd.slice('claude '.length).slice(1, -1)).not.toContain('"');
    });

    it('strips what every shell would expand, not just what THIS one would', () => {
        // The line is typed into whichever shell the user has set, on whichever OS.
        // `$`/backtick substitute in bash and PowerShell; `%VAR%` expands in cmd;
        // and `!` history-expands in an interactive bash — where a FAILED expansion
        // rejects the entire line, so an agent named "Fix It!" would never launch
        // at all rather than launch slightly wrong.
        const cmd = withPersonaBriefing(
            'claude',
            'C:/%USERPROFILE%/$HOME/.agents/s.md',
            'Fix It! `whoami`',
        );
        const briefing = cmd.slice('claude '.length).slice(1, -1);
        for (const ch of ['"', '`', '$', '!', '%', '\n', '\r']) {
            expect(briefing).not.toContain(ch);
        }
    });

    it('leaves the path readable after the strip, on Windows too', () => {
        // Backslashes become forward slashes rather than vanishing: a trailing one
        // escapes the closing quote, and every TUI opens the file either way.
        expect(withPersonaBriefing('claude', 'C:\\Apps\\t\\.agents\\s.md', 'S')).toContain(
            'C:/Apps/t/.agents/s.md',
        );
    });
});
