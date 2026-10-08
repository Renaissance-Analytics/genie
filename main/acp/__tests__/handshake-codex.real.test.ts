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

/**
 * The reasons a skip would be legitimate, from two facts and NOTHING ELSE.
 *
 * Pure and exported so the WORDING can be asserted in both states on any machine. See the twin of
 * this in `handshake.real.test.ts` for why: the old assertion was `expect(Array.isArray(missing))`,
 * which passes whatever the machine has, so the claim that this block proves a skip can say WHY was
 * never checked. prism found the sharper form of the same defect reviewing this pattern — an
 * assertion comparing a value to the expression that defined it, inside the one block whose purpose
 * is to be able to fail.
 */
export function missingPreconditions(f: { host: string | null; credentials: string | null; codexHome: string }): string[] {
    const missing: string[] = [];
    if (!f.host) missing.push('ACP host or prism-acp not present');
    if (!f.credentials) missing.push(`no codex home found at ${f.codexHome}`);
    return missing;
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

    return { host, credentials, missing: missingPreconditions({ host, credentials, codexHome }) };
}

const pre = preconditions();

describe('codex preconditions', () => {
    /** A fixed sample, so these say the same thing on the owner's desktop and on CI. */
    const sample = { host: '/x/prism-host.mjs', credentials: '/home/me/.codex', codexHome: '/home/me/.codex' };

    it('says NOTHING is missing when both facts are present', () => {
        expect(missingPreconditions(sample)).toEqual([]);
    });

    it('NAMES THE PATH when the codex home is absent', () => {
        // The point of the gate. "Skipped" tells a reader nothing; "no codex home found at
        // /home/runner/.codex" distinguishes CI from a broken install here.
        const r = missingPreconditions({ ...sample, credentials: null });
        expect(r).toEqual(['no codex home found at /home/me/.codex']);
    });

    it('names the adapter when IT is missing, and both when both are', () => {
        expect(missingPreconditions({ ...sample, host: null })).toEqual(['ACP host or prism-acp not present']);
        expect(missingPreconditions({ host: null, credentials: null, codexHome: '/c' })).toHaveLength(2);
    });

    it('reports what THIS machine is missing, if anything', () => {
        // Asserts nothing, deliberately: its job is to put the reason in the run output so a real
        // skip is legible. The three cases above prove the reason can be produced at all.
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

            /**
             * DOES CODEX ECHO THE OWNER'S PROMPT? — measured, because prism asked us not to take
             * their reading of their own code for it, and because a wrong answer costs a visible bug
             * either way.
             *
             * claude does not (`handshake.real.test.ts`: no `user_message_chunk` live, and
             * `session/load` replays nothing). prism's correction: *"the codex driver maps a
             * `userMessage` item to `user_message_chunk` whenever it carries text, on replay and
             * live… the same client code is lossy against one provider and duplicating against the
             * other."* They were explicit that they had verified their MAPPING and not codex's live
             * frames — *"I am not going to assert what codex emits on the strength of reading my own
             * code; that is precisely the move that produced the approval bug."*
             *
             * It matters here because Genie now records the owner's own prompt itself
             * (`recordHumanPromptForSpec`), the agent having no obligation to. If codex echoes, that
             * record and the echo are the same message twice — the mirror image of the defect the
             * record was added to fix.
             *
             * ## What the first run of this found, and why the COUNT is logged
             *
             * On 0.5.2 it was `prompt echoes=2` — two identical whole-text frames — and that was
             * prism's defect rather than codex's: `#mapItem` runs at both `item/started` and
             * `item/completed`, and the `userMessage` branch was missing the `if (replay || completed)`
             * guard its sibling branches have. They shipped 0.5.3 with the guard and with tests that
             * COUNT the frames, their own words being that *"the entire bug was a missing guard that
             * any 'a user message was emitted' assertion would have sailed past"*.
             *
             * Which is why this logs a count and not a boolean. A regression of that guard restores a
             * doubled prompt in the owner's own transcript, and `user_message_chunk` appearing at all
             * is exactly the assertion that would miss it.
             *
             * Logged, not asserted: this is the reading, and an assertion would freeze whichever
             * answer today's adapter happens to give.
             */
            const kinds = [
                ...new Set(
                    updates.map((f) => {
                        try {
                            const p = JSON.parse(f) as { update?: { sessionUpdate?: string } };
                            return p.update?.sessionUpdate ?? 'unknown';
                        } catch {
                            return 'unparsed';
                        }
                    }),
                ),
            ].sort();
            const echoes = updates.filter((f) => f.includes('user_message_chunk'));
            // eslint-disable-next-line no-console
            console.log(`[codex transcript] live=${kinds.join(',') || 'none'} | prompt echoes=${echoes.length}`);
            // The FRAMES, not just the count. Two echoes could be two chunks of one message — which
            // coalesce by `messageId` and need prefix matching to suppress — or two separate
            // messages, which do not. The suppression Genie has to write depends on which, so the
            // ids and the text go in the log rather than being guessed at from a number.
            for (const f of echoes.slice(0, 4)) {
                // eslint-disable-next-line no-console
                console.log(`[codex echo] ${f.slice(0, 400)}`);
            }
        } finally {
            started.kill();
        }
    }, 180_000);
});
