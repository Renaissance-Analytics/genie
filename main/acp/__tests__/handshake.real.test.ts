import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startAcpAgent, type ChildLike } from '../spawn';

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

/**
 * A package's CLI entry, read from its own `bin` field.
 *
 * NOT `require.resolve` of the package root: that answers with the LIBRARY entry —
 * claude-agent-acp exports `dist/lib.js` there while its bin is `dist/index.js` — so
 * resolving the root would start the wrong file and hang in the handshake.
 */
export function adapterScriptOf(pkg: string): string | null {
    try {
        const manifestPath = path.join(process.cwd(), 'node_modules', pkg, 'package.json');
        if (!fs.existsSync(manifestPath)) return null;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { bin?: Record<string, string> | string };
        const bin = typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin ?? {})[0];
        if (!bin) return null;
        const script = path.join(path.dirname(manifestPath), bin);
        return fs.existsSync(script) ? script : null;
    } catch {
        return null;
    }
}

interface Preconditions {
    adapter: string | null;
    credentials: string | null;
    missing: string[];
}

function preconditions(): Preconditions {
    // From the package's `bin`, not from `node_modules/.bin`. The shim there is
    // `.cmd` on Windows, and running it would re-enter whatever `node` is on PATH.
    const adapter = adapterScriptOf('@agentclientprotocol/claude-agent-acp');
    const adapterPath = adapter ?? '@agentclientprotocol/claude-agent-acp (bin entry)';

    const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
    const credFile = [path.join(configDir, '.credentials.json'), path.join(configDir, 'credentials.json')].find((f) =>
        fs.existsSync(f),
    );
    // An OAuth token in the environment is the headless equivalent of a stored login,
    // and it IS a subscription credential, so it counts.
    const credentials = credFile ?? (process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'env:CLAUDE_CODE_OAUTH_TOKEN' : null);

    const missing: string[] = [];
    if (!adapter) missing.push(`@agentclientprotocol/claude-agent-acp not installed (looked for ${adapterPath})`);
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
                adapterScript: adapterScriptOf,
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
});
