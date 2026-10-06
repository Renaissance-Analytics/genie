import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acpLaunch, PRISM_HOST_FILENAME } from '../agent-spec';

/**
 * ACP runs on PRISM now — the third-party adapter is gone and not coming back.
 *
 * Owner rulings that got us here: *"NO 3RD PARTY!!!"*, and *"prism is our source of all
 * agentic solutions."* `@agentclientprotocol/claude-agent-acp` was removed from
 * `dependencies`, which left the launch table naming a package that is not installed — so
 * turning `acp_engine` on produced `adapter-missing` and the transport was a dead end.
 *
 * `@particle-academy/prism-acp` replaces it. Two things about it change the launch shape:
 *
 * **It is a LIBRARY, not a bin.** `exports` offers `import` only — no `bin`, no `require`.
 * So Genie supplies its own ESM host that calls `serve(...)` and spawns THAT. Which
 * incidentally deletes the whole `.cmd`-shim hazard: the entry is ours, at a path we
 * control, so there is no shim to re-enter whatever `node` is first on PATH.
 *
 * **It has zero dependencies**, so nothing third-party arrives transitively.
 */

describe('claude launches through our own prism host', () => {
    const ctx = { nodeExec: '/n/node', hostScript: () => '/app/main/acp/prism-host.mjs' };

    it('spawns <node> <our host>, not a third-party package', () => {
        expect(acpLaunch('claude', ctx)).toEqual({
            ok: true,
            launch: { command: '/n/node', args: ['/app/main/acp/prism-host.mjs'] },
        });
    });

    it('names no @agentclientprotocol package anywhere in the launch', () => {
        const got = acpLaunch('claude', ctx);
        expect(JSON.stringify(got)).not.toContain('agentclientprotocol');
    });

    it('refuses when the host script is missing, rather than spawning nothing', () => {
        // A missing host is a packaging fault. Spawning `node` with no script would start
        // a REPL that never answers the handshake — a hung agent rather than a named fault.
        expect(acpLaunch('claude', { ...ctx, hostScript: () => null })).toMatchObject({
            ok: false,
            reason: 'host-missing',
        });
    });
});

describe('providers prism does not drive yet', () => {
    const ctx = { nodeExec: '/n/node', hostScript: () => '/app/main/acp/prism-host.mjs' };

    it('REFUSES codex, because prism-acp ships a claude driver only', () => {
        // Measured in the published package: `dist/claude/` is the only driver. Pointing
        // codex at the claude host would start something that cannot drive it and then
        // time out in the handshake — indistinguishable from a hung agent.
        expect(acpLaunch('codex', ctx)).toEqual({ ok: false, reason: 'no-acp-mode', provider: 'codex' });
    });

    it('leaves gemini and kimi on their own native ACP modes', () => {
        // They speak ACP themselves, so there is no adapter and no third party at all.
        expect(acpLaunch('gemini', ctx)).toEqual({ ok: true, launch: { command: 'gemini', args: ['--acp'] } });
        expect(acpLaunch('kimi', ctx)).toEqual({ ok: true, launch: { command: 'kimi', args: ['acp'] } });
    });

    it('still refuses a provider with no ACP mode at all', () => {
        expect(acpLaunch('aider', ctx)).toEqual({ ok: false, reason: 'no-acp-mode', provider: 'aider' });
    });
});

describe('the host script really exists in the tree', () => {
    it('is present at the name the launcher asks for', () => {
        // The guard that stops this being a path that only resolves in a test. Without it
        // every assertion above could pass against a filename nobody shipped.
        const here = path.resolve(__dirname, '..');
        expect(fs.existsSync(path.join(here, PRISM_HOST_FILENAME))).toBe(true);
    });

    it('is .mjs, because prism-acp is ESM-only and main is CommonJS', () => {
        // `exports` offers `import` and no `require`. A `.js` host inside this CommonJS
        // tree could not import it, and the failure would arrive at spawn time.
        expect(PRISM_HOST_FILENAME).toMatch(/\.mjs$/);
    });

    it('calls serve() with a claude driver, over stdio', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '..', PRISM_HOST_FILENAME), 'utf8');
        expect(src).toContain('@particle-academy/prism-acp');
        expect(src).toMatch(/serve\s*\(/);
        expect(src).toContain('ClaudeDriver');
        // ACP is stdio by definition; a host that bound a port would not be an ACP agent.
        expect(src).toContain('process.stdin');
        expect(src).toContain('process.stdout');
    });
});
