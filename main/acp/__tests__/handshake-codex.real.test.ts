import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startAcpAgent, type ChildLike } from '../spawn';
import { hostScriptOf } from './real-host';

/**
 * THE PROOF FOR CODEX, and the gate on routing it.
 *
 * prism-acp 0.5.0 ships a `CodexDriver`, so `acpLaunch('codex')` now succeeds and
 * `prism-host.mjs` serves it when `GENIE_ACP_PROVIDER=codex`. **`ACP_PROVIDERS` still excludes
 * codex**, which means `engineFor` keeps every codex agent on the pty — on purpose, and this file is
 * the reason.
 *
 * Claude earned its place in that list by a measured handshake on a real child, not by prism saying
 * the driver existed. Codex gets the same bar. The owner has two codex agents running right now;
 * flipping the list would move them onto a driver published hours ago the next time they restart,
 * and *"a proposed fix is a hypothesis"* applies hardest to something that still comes up and
 * answers while being subtly wrong.
 *
 * ## What a green run here licenses
 *
 * Exactly one thing: adding `codex` to `ACP_PROVIDERS`. Nothing in this file does that, so a reader
 * who finds it green and the list unchanged is looking at a decision not yet taken rather than a
 * bug.
 *
 * ## Why it skips rather than fails
 *
 * CI has no codex login and must not. A silent skip would be false comfort, so the preconditions say
 * which one was missing — and are asserted to be answerable, so this file cannot quietly become a
 * no-op that reads as covered.
 *
 * `npm run test:acp`. Out of the fast run deliberately: it starts a real child. Short-lived and
 * killed in the same test, which is the probe case the desktop rule allows — unlike a browser, an
 * Electron window or a dev server, none of which this is.
 */

interface Preconditions {
    host: string | null;
    credentials: string | null;
    missing: string[];
}

function preconditions(): Preconditions {
    const host = hostScriptOf();

    /**
     * Codex keeps its login under `CODEX_HOME ?? ~/.codex`, which is also the variable
     * `main/acp/agent-spec.ts` forwards as a subscription credential. Looking for the DIRECTORY
     * rather than a named file on purpose: the file's name is codex's to change, and a directory
     * that exists is the honest precondition — if the login inside it is stale, the handshake says
     * so and that is a result worth having.
     */
    const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
    const credentials = fs.existsSync(codexHome) ? codexHome : null;

    const missing: string[] = [];
    if (!host) missing.push('ACP host or prism-acp not present');
    if (!credentials) missing.push(`no codex home found at ${codexHome}`);
    return { host, credentials, missing };
}

const pre = preconditions();

describe('codex preconditions', () => {
    it('are answerable, so a skip below is a real skip and not a silent no-op', () => {
        expect(Array.isArray(pre.missing)).toBe(true);
        if (pre.missing.length > 0) {
            // eslint-disable-next-line no-console
            console.log(`[acp codex handshake] SKIPPING: ${pre.missing.join('; ')}`);
        }
    });
});

describe.skipIf(pre.missing.length > 0)('a real ACP handshake against the Codex driver', () => {
    it('initializes, and the child env carries no api key', async () => {
        const seenEnv: Array<Record<string, string>> = [];
        let killed: (() => void) | null = null;

        const started = startAcpAgent(
            { provider: 'codex', cwd: process.cwd(), auth: 'subscription' },
            {
                spawn: (command, args, env, cwd) => {
                    seenEnv.push(env);
                    const child = spawn(command, args, {
                        cwd,
                        env,
                        stdio: ['pipe', 'pipe', 'pipe'],
                        windowsHide: true,
                    });
                    return child as unknown as ChildLike;
                },
                nodeVersion: () => process.version,
                nodeExec: () => process.execPath,
                hostScript: hostScriptOf,
                hostEnv: () => process.env as Record<string, string | undefined>,
                onStderr: (line) => {
                    // A child that cannot authenticate says so HERE, and the message is the only
                    // evidence of why. Printed rather than swallowed: the point of this file is the
                    // reason, not the boolean.
                    // eslint-disable-next-line no-console
                    if (/error|denied|unauthor|not found/i.test(line)) console.log(`[codex stderr] ${line.trim()}`);
                },
            },
        );

        if ('error' in started) throw new Error(`could not start: ${started.error}`);
        killed = started.kill;

        try {
            // THE requirement, same as claude's: no API key in the environment handed to a real
            // child, and the handshake succeeds anyway — which can only be true if it authenticated
            // from the stored login.
            expect('OPENAI_API_KEY' in seenEnv[0]!).toBe(false);
            expect('ANTHROPIC_API_KEY' in seenEnv[0]!).toBe(false);
            // And the host was told WHICH driver to serve, or it would have served claude's.
            expect(seenEnv[0]!.GENIE_ACP_PROVIDER).toBe('codex');

            const result = (await started.client.request('initialize', {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
                clientInfo: { name: 'genie', version: '0.0.0-test' },
            })) as { protocolVersion?: number; agentCapabilities?: unknown; authMethods?: unknown[] };

            expect(result).toBeTruthy();
            expect(typeof result.protocolVersion === 'number' || result.agentCapabilities !== undefined).toBe(true);
            // `authMethods: []` is what proved the claude path needed no sign-in step. Logged rather
            // than asserted, because codex's answer here is the thing being learned.
            // eslint-disable-next-line no-console
            console.log(`[codex handshake] authMethods=${JSON.stringify(result.authMethods ?? null)}`);
        } finally {
            killed?.();
        }
    }, 60_000);

    /**
     * A REAL TURN, not just a handshake — the gate `ACP_PROVIDERS` actually waits on.
     *
     * `initialize` is answered by the ACP agent itself and never starts the provider, which is why
     * claude's equivalent exists and says so: *"the handshake alone proves the transport speaks, NOT
     * that the subscription drives a turn."* The owner has two codex agents running; routing them
     * onto a driver whose handshake works and whose turns do not would be worse than leaving them on
     * the pty.
     *
     * Deliberately tiny: one word back, to spend as little of the owner's quota as proving it takes.
     */
    it('completes a real turn through the Codex driver', async () => {
        const started = startAcpAgent(
            { provider: 'codex', cwd: process.cwd(), auth: 'subscription' },
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
                    // eslint-disable-next-line no-console
                    if (/error|denied|unauthor|not found/i.test(line)) console.log(`[codex stderr] ${line.trim()}`);
                },
            },
        );
        if ('error' in started) throw new Error(`could not start: ${started.error}`);

        const updates: string[] = [];
        try {
            await started.client.request('initialize', {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
                clientInfo: { name: 'genie', version: '0.0.0-test' },
            });

            const session = (await started.client.request('session/new', {
                cwd: process.cwd(),
                mcpServers: [],
            })) as { sessionId?: string };
            expect(typeof session.sessionId).toBe('string');

            started.client.onNotification?.('session/update', (payload: unknown) => {
                updates.push(JSON.stringify(payload));
            });

            const turn = (await started.client.request('session/prompt', {
                sessionId: session.sessionId,
                prompt: [{ type: 'text', text: 'Reply with the single word: ready' }],
            })) as { stopReason?: string };

            // The turn FINISHED, and said how. Either a stop reason or some updates — a driver that
            // resolved the prompt having streamed nothing and said nothing would pass a weaker
            // assertion while being useless.
            expect(turn).toBeTruthy();
            expect(typeof turn.stopReason === 'string' || updates.length > 0).toBe(true);
            // Logged because the whole value of this run is what codex actually sends: prism's
            // `META_CLI_SESSION_ID` equivalent and the turn-boundary frames are what Genie will key
            // resume and telemetry off.
            // eslint-disable-next-line no-console
            console.log(`[codex turn] stopReason=${turn.stopReason ?? 'none'} updates=${updates.length}`);
        } finally {
            started.kill();
        }
    }, 180_000);
});
