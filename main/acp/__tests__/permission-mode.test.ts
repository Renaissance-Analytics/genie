import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACP_PROVIDERS, acpEnv, CLAUDE_ACP_PERMISSION_MODE } from '../agent-spec';
import { codeOnly } from '../../__tests__/support/code-only';

/**
 * AN ACP AGENT MUST BE ABLE TO DO WORK — genie#838.
 *
 * Measured against a real `claude` child on 2026-10-08: Genie passed the CLI **no
 * `--permission-mode`**, and without one it denies every tool call —
 *
 *   > Permission to use Write has been denied because Claude Code is running in
 *   > don't ask mode.
 *
 * Three real turns, three working directories: the two launched as Genie ships left the
 * directory **EMPTY**; the one launched with a mode left `hello.txt` in it. So version 2's
 * agents could not edit a file at all, which the pty path they replaced had always been able
 * to do — `main/agents/os-agent.ts` launches `claude --dangerously-skip-permissions`.
 *
 * ## Why claude and NOT codex
 *
 * The two drivers are not symmetric, and the asymmetry is the whole design:
 *
 *  - **CodexDriver RAISES permission requests** (`onRequestPermission` → ACP's
 *    `session/request_permission`), and Genie answers them in `permission.ts`. That is the
 *    better path — a human in the loop — and forcing a mode on codex would destroy it.
 *  - **ClaudeDriver has no permission plumbing at all**: no `onRequestPermission` in its
 *    events interface, nothing in its implementation. It cannot ask. So for claude the only
 *    two reachable states are "proceeds" and "denied", and a mode is what picks.
 *
 * So the mode is claude-only, deliberately, and this file asserts BOTH halves — because the
 * failure that would hurt is not a missing variable, it is a variable quietly applied to the
 * provider whose human-in-the-loop path it breaks.
 *
 * ## And why a source guard on the host script
 *
 * `prism-host.mjs` is the only place the driver is constructed, and it is not unit-testable
 * — it is an ESM entry that speaks on stdio. An env var nobody reads is precisely the defect
 * that cost this project a day (`acp_engine`: a settings row, a UI switch, two release notes,
 * and no reader anywhere). Setting the variable and asserting only that it is set would
 * reproduce that exactly, so the guard reads the host's real source.
 */

const HOST = path.resolve(__dirname, '..', 'prism-host.mjs');

describe('a claude ACP child is told how to handle permissions', () => {
    it('carries the mode for claude, because its driver cannot ask', () => {
        /**
         * THE CONSTANT IS PROVEN TO EXIST FIRST, and that is not ceremony.
         *
         * Written as `expect(env.GENIE_ACP_PERMISSION_MODE).toBe(CLAUDE_ACP_PERMISSION_MODE)`
         * alone, this test PASSED against the unfixed code — both sides were `undefined`, so
         * the one assertion that proves the fix exists was comparing one absence to another.
         * It was caught by reading which cases went red, not by the count.
         *
         * A non-empty string on the left is what makes the equality mean something.
         */
        expect(typeof CLAUDE_ACP_PERMISSION_MODE).toBe('string');
        expect(CLAUDE_ACP_PERMISSION_MODE.length).toBeGreaterThan(0);

        const env = acpEnv('claude', { PATH: '/bin' }, { auth: 'subscription' });
        expect(env.GENIE_ACP_PERMISSION_MODE).toBe(CLAUDE_ACP_PERMISSION_MODE);
    });

    it('is a mode the CLI actually accepts', () => {
        // prism types it as `ClaudePermissionMode`, which maps onto the CLI's own
        // `--permission-mode` values. A typo here is a flag the binary rejects at spawn, and
        // the symptom would be an agent that will not start rather than one that cannot edit.
        expect(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']).toContain(
            CLAUDE_ACP_PERMISSION_MODE,
        );
    });

    it('does NOT carry it for codex, whose driver asks a human instead', () => {
        // The positive control for the test above. Without this, setting the variable
        // unconditionally would pass the first assertion while silently overriding the one
        // provider that can put a person in the loop.
        const env = acpEnv('codex', { PATH: '/bin' }, { auth: 'subscription' });
        expect(env.GENIE_ACP_PERMISSION_MODE).toBeUndefined();
    });

    it('does not carry it for any other provider Genie routes over ACP', () => {
        // `ACP_PROVIDERS` grows — gemini and kimi are already in it. A mode invented for
        // claude's missing plumbing must not be handed to a provider nobody has measured,
        // so the default is silence and claude is the single named exception.
        for (const provider of ACP_PROVIDERS) {
            if (provider === 'claude') continue;
            const env = acpEnv(provider, { PATH: '/bin' }, { auth: 'subscription' });
            expect(env.GENIE_ACP_PERMISSION_MODE, `${provider} must not be given a mode`).toBeUndefined();
        }
    });
});

describe('the host script actually READS it', () => {
    const source = codeOnly(fs.readFileSync(HOST, 'utf8'));

    it('reads the variable and hands a permissionMode to the claude driver', () => {
        // Comments stripped (`codeOnly`, CRLF-safe): a guard satisfied by the prose that
        // explains it is a guard that cannot fail.
        expect(source).toMatch(/GENIE_ACP_PERMISSION_MODE/);
        expect(source).toMatch(/permissionMode/);
    });

    it('gives it to ClaudeDriver and not to CodexDriver', () => {
        // The asymmetry again, at the one site that builds the drivers. `CodexDriverOptions`
        // has no `permissionMode` — handing it one would be a silent no-op today and a
        // behaviour change the day prism adds the field.
        const codexLine = source.split('\n').find((l) => l.includes('new CodexDriver'));
        expect(codexLine).toBeTruthy();
        expect(codexLine).not.toMatch(/permissionMode/);
    });
});
