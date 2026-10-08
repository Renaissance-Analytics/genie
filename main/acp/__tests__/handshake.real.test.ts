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

/**
 * The reasons a skip would be legitimate, derived from two facts and NOTHING ELSE.
 *
 * Pure and exported so the wording can be asserted in BOTH states on any machine. The previous
 * assertion was `expect(Array.isArray(pre.missing)).toBe(true)`, which passes whatever the machine
 * has — so the claim in the comment beside it, that this block proves the skip can say WHY, was
 * never actually checked. prism hit the same class of defect reviewing this pattern and found the
 * sharper version in their own copy: `expect(missing).toEqual(hasHome ? [] : [...])`, comparing a
 * value to the expression that defined it three lines above. A tautology inside the one block whose
 * entire purpose is to be able to fail.
 *
 * Their fix is the one adopted here — assert against a fixed sample in both states, so the
 * formatting is proved everywhere rather than in whichever state this machine happens to be in.
 */
export function missingPreconditions(f: { adapter: string | null; credentials: string | null; configDir: string }): string[] {
    const missing: string[] = [];
    if (!f.adapter) {
        missing.push(
            `ACP host or prism-acp not present (looked for main/acp/prism-host.mjs + @particle-academy/prism-acp)`,
        );
    }
    if (!f.credentials) missing.push(`no Claude subscription login found under ${f.configDir}`);
    return missing;
}

function preconditions(): Preconditions {
    // From the package's `bin`, not from `node_modules/.bin`. The shim there is
    // `.cmd` on Windows, and running it would re-enter whatever `node` is on PATH.
    const adapter = hostScriptOf();

    const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
    const credFile = [path.join(configDir, '.credentials.json'), path.join(configDir, 'credentials.json')].find((f) =>
        fs.existsSync(f),
    );
    // An OAuth token in the environment is the headless equivalent of a stored login,
    // and it IS a subscription credential, so it counts.
    const credentials = credFile ?? (process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'env:CLAUDE_CODE_OAUTH_TOKEN' : null);

    return { adapter, credentials, missing: missingPreconditions({ adapter, credentials, configDir }) };
}

const pre = preconditions();

describe('preconditions', () => {
    /** A fixed sample, so these assertions say the same thing on the owner's desktop and on CI. */
    const sample = { adapter: '/x/prism-host.mjs', credentials: '/home/me/.claude/.credentials.json', configDir: '/home/me/.claude' };

    it('says NOTHING is missing when both facts are present', () => {
        expect(missingPreconditions(sample)).toEqual([]);
    });

    it('NAMES THE PATH when the login is absent, which is what makes a skip readable', () => {
        // "Skipped" tells a reader nothing. "no Claude subscription login found under
        // /home/runner/.claude" distinguishes CI from a broken install on this machine, which is the
        // entire reason this block is not itself skipped.
        const r = missingPreconditions({ ...sample, credentials: null });
        expect(r).toHaveLength(1);
        expect(r[0]).toContain('/home/me/.claude');
        expect(r[0]).toContain('login');
    });

    it('names the adapter when IT is the one missing, and both when both are', () => {
        expect(missingPreconditions({ ...sample, adapter: null })[0]).toContain('prism-acp');
        expect(missingPreconditions({ adapter: null, credentials: null, configDir: '/c' })).toHaveLength(2);
    });

    it('reports what THIS machine is missing, if anything', () => {
        /**
         * ASSERTS NOTHING, deliberately, and says so rather than dressing up as a check. Its job is
         * to put the reason in the run output so a real skip is legible; the three cases above are
         * what prove the reason can be produced at all.
         *
         * The first draft of this line DID assert — `expect(pre.missing).toEqual(
         * missingPreconditions({ ...pre, configDir }))` — which compares a value to the function that
         * produced it. That is precisely the tautology prism found in their copy of this gate, written
         * here while fixing it. A line that cannot fail is worse inside a positive control than
         * anywhere else, because the file's whole claim is that this block can fail.
         */
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

            /**
             * MEASURED HERE, on the same turn, because a design decision hangs on it:
             * **does a declared transcript contain the owner's own prompts?**
             *
             * `mergeDeclared` has to decide what happens to the floor transcript, which is
             * built from the AgentInbox DM thread, when a declared one exists. P7 folds
             * human<->agent DMs into the Conversation, and an ACP agent's DMs are delivered
             * as prompts (`acpMailSender`), so the two streams may hold the same text twice
             * -- or the declared one may hold none of it. Concatenating is right in one case
             * and duplicates every DM in the other, and the difference is a fact about the
             * agent, not something to reason out.
             *
             * Two readings, both free once the turn above has run:
             *
             *  - LIVE: did the agent echo the prompt we just sent as `user_message_chunk`?
             *  - REPLAY: does `session/load` replay the history, prompts included?
             *
             * Logged rather than asserted either way, because this is the measurement and an
             * assertion here would freeze whichever answer today's adapter happens to give.
             */
            const kindsOf = (frames: string[]) =>
                [
                    ...new Set(
                        frames.map((f) => {
                            try {
                                const p = JSON.parse(f) as { update?: { sessionUpdate?: string } };
                                return p.update?.sessionUpdate ?? 'unknown';
                            } catch {
                                return 'unparsed';
                            }
                        }),
                    ),
                ].sort();

            const liveKinds = kindsOf(updates);

            // The replay reading needs a SECOND child: measured, `session/load` against the
            // child that owns an open session is refused outright -- *"session ... is already
            // open and its agent is still running (-32602)"* -- which is itself the answer to
            // whether Genie may re-load a live session. Spawning another child costs no quota;
            // only the turn above did, and it is not repeated.
            //
            // And the id to resume with is NOT the one `session/new` returned: prism refuses
            // that one by name -- *"an ACP session id minted by this server and cannot be
            // resumed by the provider. Resume with the CLI's own session id, sent as
            // 'particle.academy/cli_session_id' in the _meta of the first session/update"* --
            // which is the provenance distinction `acpResumeSessionId` already encodes, now
            // confirmed by the adapter's own refusal rather than inferred from its source.
            started.kill();
            const cliSessionId = updates
                .map((f) => {
                    try {
                        const p = JSON.parse(f) as { _meta?: Record<string, unknown>; update?: { _meta?: Record<string, unknown> } };
                        const meta = p.update?._meta ?? p._meta;
                        const v = meta?.['particle.academy/cli_session_id'];
                        return typeof v === 'string' && v.trim() !== '' ? v : null;
                    } catch {
                        return null;
                    }
                })
                .find((v): v is string => v !== null);
            const replayKinds = cliSessionId
                ? await loadReplayKinds(cliSessionId, kindsOf)
                : 'no cli_session_id in any update _meta';

            // eslint-disable-next-line no-console
            console.log(
                `[acp transcript] live=${liveKinds.join(',') || 'none'} | replay=${replayKinds}`,
            );
        } finally {
            started.kill();
        }
    }, 180_000);
});

/**
 * Resume `sessionId` in a FRESH child and report which `session/update` kinds replay.
 *
 * Separate because the reading is about a second process, and because the turn test above
 * must not grow a second spawn inline where it would read as part of the proof.
 */
async function loadReplayKinds(
    sessionId: string,
    kindsOf: (frames: string[]) => string[],
): Promise<string> {
    const second = startAcpAgent(
        { provider: 'claude', cwd: process.cwd(), auth: 'subscription' },
        {
            spawn: (command, args, env, cwd) =>
                spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as unknown as ChildLike,
            nodeVersion: () => process.version,
            nodeExec: () => process.execPath,
            hostScript: hostScriptOf,
            hostEnv: () => process.env as Record<string, string | undefined>,
        },
    );
    if ('error' in second) return `could not start a second child: ${second.error}`;

    const replay: string[] = [];
    try {
        await second.client.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
            clientInfo: { name: 'genie', version: '0.0.0-test' },
        });
        second.client.onNotification?.('session/update', (p: unknown) => {
            replay.push(JSON.stringify(p));
        });
        await second.client.request('session/load', {
            sessionId,
            cwd: process.cwd(),
            mcpServers: [],
        });
        return `(${replay.length}) ${kindsOf(replay).join(',') || 'none'}`;
    } catch (e) {
        return `session/load failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
        second.kill();
    }
}
