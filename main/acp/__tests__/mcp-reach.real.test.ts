import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startAcpAgent, type ChildLike } from '../spawn';
import { hostScriptOf } from './real-host';

/**
 * CAN AN ACP AGENT REACH AN MCP SERVER AT ALL?
 *
 * `agent-spec.ts` asserts, in prose, that *"an ACP child gets the genie MCP server for free:
 * the CLI reads the workspace's `.mcp.json`, and the child runs in that cwd."* Everything in
 * the Genie protocol rests on that sentence — `imDone` is the mandatory finish, and the file
 * itself says an agent that cannot call it *"stalls the work in silence"*. It had no test.
 *
 * A confident comment about external behaviour with nothing exercising it is the exact shape
 * that cost this project a day: `db.ts` claimed *"`engineFor` reads this"* about a key
 * `engineFor` never mentioned, and a settings row, a UI switch and two release notes were
 * built on it. So this measures the claim instead of believing it.
 *
 * ## Why a throwaway server and not the genie one
 *
 * Pointing a test at the real rig would make every run a real side effect on the real
 * workspace. `support/mcp-probe-server.mjs` exposes ONE tool whose only action is to touch a
 * file, so the proof is an artifact on disk — the same discipline that caught the permission
 * defect, where a denied turn and a successful one produced identical frames.
 *
 * It also isolates what is being tested. If this passes, the CLI loads `.mcp.json` from its
 * cwd and will call a tool in it; whether the GENIE server then answers is a separate claim
 * about that server, not about ACP.
 *
 * ## What a failure here would mean
 *
 * That Genie 2's agents cannot call `imDone`, `ForceTheQuestion` or `agentinbox` — i.e. the
 * protocol does not work over ACP. That is worth one small turn of the owner's subscription to
 * know for certain, which is why it lives in the opt-in `test:acp` lane and skips, loudly,
 * wherever the adapter or the login is absent.
 */

const PROBE = path.resolve(__dirname, 'support', 'mcp-probe-server.mjs');

function preconditions(): { missing: string[] } {
    const missing: string[] = [];
    if (!hostScriptOf()) missing.push('ACP host or prism-acp not installed');
    if (!(process.env.USERPROFILE ?? process.env.HOME)) missing.push('no home, so no stored login');
    if (!fs.existsSync(PROBE)) missing.push(`probe MCP server missing at ${PROBE}`);
    return { missing };
}

const pre = preconditions();

if (pre.missing.length > 0) {
    console.log(`[acp] skipping "mcp reach": ${pre.missing.join('; ')}`);
}

describe.skipIf(pre.missing.length > 0)('an ACP agent can call a tool on an MCP server', () => {
    it('loads .mcp.json from its cwd and calls the tool in it', async () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-acp-mcp-'));
        const marker = path.join(work, 'probe-was-called.txt');

        // The workspace config the CLI is claimed to read. Written with an ABSOLUTE path to the
        // server, because a relative one would silently resolve against whatever the CLI
        // considers its own cwd and a failure would be indistinguishable from "did not load".
        fs.writeFileSync(
            path.join(work, '.mcp.json'),
            JSON.stringify(
                {
                    mcpServers: {
                        probe: {
                            command: process.execPath,
                            args: [PROBE],
                            env: { MCP_PROBE_MARKER: marker },
                        },
                    },
                },
                null,
                2,
            ),
            'utf8',
        );

        const started = startAcpAgent(
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
                    // An MCP server the CLI rejected says so here and nowhere else, so this is the
                    // only place a "config loaded but server refused" outcome is visible.
                    if (/mcp|error|denied|unauthor/i.test(line)) console.log(`[acp stderr] ${line.trim()}`);
                },
            },
        );
        if ('error' in started) throw new Error(`could not start: ${started.error}`);

        const frames: string[] = [];
        let called = false;
        let left: string[] = [];

        try {
            await started.client.request('initialize', {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
                clientInfo: { name: 'genie', version: '2' },
            });

            // `mcpServers: []` EXACTLY as production sends it (`acp/session.ts`). The claim under
            // test is that the CLI's own config supplies the servers, so injecting one here would
            // prove a different and easier thing.
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
                        text: 'Call the probe_ping tool from the probe MCP server, with no arguments. Then stop.',
                    },
                ],
            });
        } finally {
            started.kill();
            called = fs.existsSync(marker);
            try {
                left = fs.readdirSync(work);
            } catch {
                left = ['<unreadable>'];
            }
            try {
                fs.rmSync(work, { recursive: true, force: true });
            } catch {
                // EBUSY on Windows: the dying child still holds its cwd. Not a measurement failure.
            }
        }

        const toolNames = frames
            .map((f) => JSON.parse(f) as { update?: Record<string, unknown> })
            .map((p) => p.update ?? {})
            .filter((u) => String(u['sessionUpdate']).startsWith('tool_call'))
            .map((u) => String(u['name'] ?? u['title'] ?? '·'));

        // THE ARTIFACT, not the transcript. An agent can SAY it pinged; only the server can
        // write this file.
        expect(
            called,
            `probe marker absent — the agent left ${JSON.stringify(left)} and made these tool calls: ${JSON.stringify(toolNames)}`,
        ).toBe(true);
    }, 180_000);
});
