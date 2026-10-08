import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startAcpAgent, type ChildLike } from '../spawn';
import { hostScriptOf } from './real-host';

/**
 * AN ACP AGENT CAN ACTUALLY DO WORK — the regression test for genie#838.
 *
 * Everything else about ACP was proven before this file existed: the handshake, the
 * subscription with no API token, the update mapping, the plan rail. All of it green, and an
 * agent still **could not edit a file**. Genie passed the claude CLI no `--permission-mode`,
 * and without one it refuses every tool call:
 *
 *   > Permission to use Write has been denied because Claude Code is running in
 *   > don't ask mode.
 *
 * Version 2's whole premise is that agents move off the pty onto ACP. The pty path appends
 * `--dangerously-skip-permissions` (`main/agents/os-agent.ts`); the ACP path appended
 * nothing, so the migration silently removed the agents' ability to work. Nothing in a
 * 12,000-test suite noticed, because every ACP test either used a fake or asked the real
 * child for a sentence of prose — and prose needs no tools.
 *
 * ## So this test asserts the ARTIFACT, not the traffic
 *
 * The frames are identical whether an edit lands or is denied: `tool_call`, then
 * `tool_call_update`, then a terminal status. Counting them, or asserting that the turn
 * finished, passes in both worlds. The only assertion that can tell them apart is **reading
 * the file back off the disk**, which is what this does.
 *
 * Measured both ways when it was written: two turns launched as Genie shipped left the
 * working directory EMPTY; one with a mode left `hello.txt` in it.
 *
 * ## Why it is in the opt-in lane
 *
 * `npm run test:acp`. It starts a real child and spends a small amount of the owner's
 * subscription, so it has no business running on every `npm test` — the same call the
 * handshake lane makes. It SKIPS, naming the missing precondition, when the adapter or the
 * login is absent, which is CI's normal state and must stay that way.
 */

function preconditions(): { adapter: string | null; home: string | null; missing: string[] } {
    const adapter = hostScriptOf();
    const home = process.env.USERPROFILE ?? process.env.HOME ?? null;
    const missing: string[] = [];
    if (!adapter) missing.push('ACP host or prism-acp not installed (main/acp/prism-host.mjs)');
    if (!home) missing.push('no home directory, so no stored subscription login');
    return { adapter, home, missing };
}

const pre = preconditions();

if (pre.missing.length > 0) {
    // Said out loud, because a silent skip in the one lane that tests the real thing is how
    // a suite becomes a no-op that still reads as covered.
    console.log(`[acp] skipping "can do work": ${pre.missing.join('; ')}`);
}

describe.skipIf(pre.missing.length > 0)('a real claude ACP agent can edit a file', () => {
    it('writes the file it was asked to write', async () => {
        // The agent works in a temp directory, never in the repo.
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-acp-work-'));

        const started = startAcpAgent(
            // EXACTLY the production shape — `acpEnv` is what supplies the permission mode, so
            // passing one here would test the test instead of the product.
            { provider: 'claude', cwd: work, auth: 'subscription' },
            {
                spawn: (command, args, env, cwd) =>
                    spawn(command, args, {
                        cwd,
                        env,
                        stdio: ['pipe', 'pipe', 'pipe'],
                        windowsHide: true,
                    }) as unknown as ChildLike,
                nodeVersion: () => process.version,
                nodeExec: () => process.execPath,
                hostScript: hostScriptOf,
                hostEnv: () => process.env as Record<string, string | undefined>,
                onStderr: (line) => {
                    if (/error|denied|unauthor/i.test(line)) console.log(`[acp stderr] ${line.trim()}`);
                },
            },
        );
        if ('error' in started) throw new Error(`could not start: ${started.error}`);

        const frames: string[] = [];
        let landed: string[] = [];
        let body: string | null = null;

        try {
            await started.client.request('initialize', {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
                clientInfo: { name: 'genie', version: '0.0.0-test' },
            });

            const session = (await started.client.request('session/new', {
                cwd: work,
                mcpServers: [],
            })) as { sessionId?: string };

            started.client.onNotification?.('session/update', (p: unknown) => {
                frames.push(JSON.stringify(p));
            });

            await started.client.request('session/prompt', {
                sessionId: session.sessionId,
                prompt: [
                    {
                        type: 'text',
                        // Deliberately tiny: one file, two bytes, so this costs as little of the
                        // owner's quota as proving it requires.
                        text: 'Create a file named hello.txt containing exactly the word hi. Then stop.',
                    },
                ],
            });
        } finally {
            started.kill();
            // READ THE OUTCOME BEFORE REMOVING THE EVIDENCE.
            try {
                landed = fs.readdirSync(work);
                body = landed.includes('hello.txt')
                    ? fs.readFileSync(path.join(work, 'hello.txt'), 'utf8')
                    : null;
            } catch {
                landed = ['<unreadable>'];
            }
            try {
                fs.rmSync(work, { recursive: true, force: true });
            } catch {
                // EBUSY: on Windows the dying child still holds its cwd for a moment. A temp
                // directory that outlives the run must not fail a measurement that succeeded.
            }
        }

        // THE ASSERTION. Not "the turn finished", not "a tool call appeared" — both are true
        // when every call is denied.
        expect(landed, `the agent left: ${JSON.stringify(landed)}`).toContain('hello.txt');
        expect(body?.trim()).toBe('hi');

        /**
         * LOGGED, not asserted: what a real tool call carries.
         *
         * Measured here and recorded in the designer brief (§8.2): the update carries `kind`
         * ("edit"), and `rawInput` with the real `file_path` and `content` — none of which
         * Genie's `ToolCall = {id, name, status}` keeps. The Workflow Dashboard's "latest
         * delivery" and the Agent view's "every edit as a diff" both depend on those fields,
         * so this prints them rather than freezing today's shape in an assertion.
         */
        const calls = frames
            .map((f) => JSON.parse(f) as { update?: Record<string, unknown> })
            .map((p) => p.update ?? {})
            .filter((u) => String(u['sessionUpdate']).startsWith('tool_call'));
        console.log(`[acp] tool-call fields seen: ${JSON.stringify(calls.map((c) => Object.keys(c)))}`);
    }, 180_000);
});
