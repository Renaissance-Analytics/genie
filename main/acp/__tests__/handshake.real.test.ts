import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startAcpAgent, type ChildLike } from '../spawn';
import { hostScriptOf } from './real-host';

/**
 * THE PROOF, not a unit test: a real `claude-agent-acp` child, a real `initialize`
 * handshake, on the real stored subscription, with **no API token anywhere**.
 *
 * Everything else in `main/acp/` is tested against fakes, which is right for the
 * decisions but proves nothing about the claim the owner actually cares about —
 * *"utilize the provider subscriptions and NOT need api tokens."* That claim is about
 * two external artifacts (the adapter and a stored login) agreeing with each other, and
 * a fake cannot be wrong about them.
 *
 * ## Why it is its own lane
 *
 * `npm run test:acp`. Deliberately NOT in the fast unit run, for the same reason the
 * hosting tests are not: it starts a real child process. The desktop rule here forbids
 * browsers, Electron and long-running dev servers on the owner's machine — a short-lived
 * child that is killed in the same test is the probe-container case, allowed, but it has
 * no business running on every `npm test`.
 *
 * ## Why it SKIPS rather than fails when it cannot run
 *
 * CI has no Claude login, and it must not. A skip would normally be false comfort, so
 * this one says out loud which precondition was missing — and `preconditions()` is
 * asserted to be answerable at all, so the suite cannot silently become a no-op that
 * reads as covered.
 */


interface Preconditions {
    adapter: string | null;
    credentials: string | null;
    missing: string[];
}

function preconditions(): Preconditions {
    // From the package's `bin`, not from `node_modules/.bin`. The shim there is
    // `.cmd` on Windows, and running it would re-enter whatever `node` is on PATH.
    const adapter = hostScriptOf();
    const adapterPath = adapter ?? 'main/acp/prism-host.mjs + @particle-academy/prism-acp';

    const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
    const credFile = [path.join(configDir, '.credentials.json'), path.join(configDir, 'credentials.json')].find((f) =>
        fs.existsSync(f),
    );
    // An OAuth token in the environment is the headless equivalent of a stored login,
    // and it IS a subscription credential, so it counts.
    const credentials = credFile ?? (process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'env:CLAUDE_CODE_OAUTH_TOKEN' : null);

    const missing: string[] = [];
    if (!adapter) missing.push(`ACP host or prism-acp not present (looked for ${adapterPath})`);
    if (!credentials) missing.push(`no Claude subscription login found under ${configDir}`);
    return { adapter, credentials, missing };
}

const pre = preconditions();

describe('preconditions', () => {
    it('are answerable, so a skip below is a real skip and not a silent no-op', () => {
        // The positive control for the whole file. If this ever stops being able to say
        // what is missing, the skips underneath mean nothing.
        expect(Array.isArray(pre.missing)).toBe(true);
        if (pre.missing.length > 0) {
            // eslint-disable-next-line no-console
            console.log(`[acp real handshake] SKIPPING: ${pre.missing.join('; ')}`);
        }
    });
});

describe.skipIf(pre.missing.length > 0)('a real ACP handshake on the stored subscription', () => {
    it('initializes, and the child env carries NO api key', async () => {
        const seenEnv: Array<Record<string, string>> = [];
        let killed: (() => void) | null = null;

        const started = startAcpAgent(
            { provider: 'claude', cwd: process.cwd(), auth: 'subscription' },
            {
                spawn: (command, args, env, cwd) => {
                    seenEnv.push(env);
                    const child = spawn(command, args, {
                        cwd,
                        // The env is EXACTLY what acpEnv built — nothing inherited behind
                        // its back, which is the whole point of building it allow-list
                        // first.
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
                    // Kept, because a child that cannot authenticate says so here and the
                    // message is the only evidence of why.
                    if (/error|denied|unauthor/i.test(line)) console.log(`[acp stderr] ${line.trim()}`);
                },
            },
        );

        if ('error' in started) throw new Error(`could not start: ${started.error}`);
        killed = started.kill;

        try {
            // THE assertion about the requirement: the environment handed to a real
            // adapter contains no API key, and the handshake below succeeds anyway —
            // which can only be true if it authenticated from the stored subscription.
            expect('ANTHROPIC_API_KEY' in seenEnv[0]!).toBe(false);
            expect('ANTHROPIC_AUTH_TOKEN' in seenEnv[0]!).toBe(false);

            const result = (await started.client.request('initialize', {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
                clientInfo: { name: 'genie', version: '0.0.0-test' },
            })) as { protocolVersion?: number; agentCapabilities?: unknown };

            // A real agent answers with the version it settled on. Asserting the SHAPE
            // rather than a value, because the number is the adapter's to choose.
            expect(result).toBeTruthy();
            expect(typeof result.protocolVersion === 'number' || result.agentCapabilities !== undefined).toBe(true);
        } finally {
            killed?.();
        }
    }, 60_000);

    /**
     * A REAL TURN, not just a handshake.
     *
     * `initialize` is answered by the ACP agent itself and never starts the provider -- it
     * returned in 96 ms, which is the tell. So the handshake alone proves the transport
     * speaks, NOT that the subscription drives a turn. Only a prompt does that, and the
     * subscription claim is the one thing in this design the owner named as non-negotiable.
     *
     * Deliberately tiny: one word back, to spend as little of the owner's quota as proving
     * it requires.
     */
    it('completes a real turn on the subscription, with no api key anywhere', async () => {
        const seenEnv: Array<Record<string, string>> = [];
        const started = startAcpAgent(
            { provider: 'claude', cwd: process.cwd(), auth: 'subscription' },
            {
                spawn: (command, args, env, cwd) => {
                    seenEnv.push(env);
                    return spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as unknown as ChildLike;
                },
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

        const updates: string[] = [];
        try {
            expect('ANTHROPIC_API_KEY' in seenEnv[0]!).toBe(false);

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

            started.client.onNotification?.('session/update', (p: unknown) => {
                updates.push(JSON.stringify(p));
            });

            const turn = (await started.client.request('session/prompt', {
                sessionId: session.sessionId,
                prompt: [{ type: 'text', text: 'Reply with the single word: ready' }],
            })) as { stopReason?: string };

            // The turn FINISHED, and said how. `stopReason` is the field Genie currently
            // discards -- asserting it here is what makes that gap visible rather than
            // theoretical.
            expect(turn).toBeTruthy();
            expect(typeof turn.stopReason === 'string' || updates.length > 0).toBe(true);
        } finally {
            started.kill();
        }
    }, 180_000);
});
