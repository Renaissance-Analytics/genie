import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readClaudeUsage } from '../src/main/claude-usage-read.js';

/**
 * READING A CLAUDE ACCOUNT'S USAGE WITH NO AGENT (Tynn #1084). Claude Code reports an account's limits only in a turn
 * (`rate_limit_event`), and prism-acp 0.48.0's ClaudeDriver has no turn-free read. So the probe is one tiny turn IN THAT
 * ACCOUNT'S FOLDER: its own default model (Genie names no model, Tynn #608), no tools, no MCP, no settings, nothing kept in the session history, its own empty
 * working folder. Genie reads no credential: Claude Code does the asking, as for any agent.
 *
 * Driven end to end: prism-acp's REAL ClaudeDriver and the stand-in CLI the usage-on-switch row uses
 * (scripts/usage-on-switch-stub-claude.mjs), which reports each folder's limit from `status.json` beside it and records
 * every launch in `calls.jsonl`.
 */
const dirs: string[] = [];
// Retried: on Windows a probe's process just ended may still hold its working folder for a moment.
afterAll(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* the runner cleans up */ } } });
function folder(name: string): string { const d = mkdtempSync(join(tmpdir(), `genie-1084-${name}-`)); dirs.push(d); return d; }

/** The stand-in, copied into a folder of its own, with what each folder reports (`limit: null`: no rate-limit frame). */
function standIn(status: Record<string, { limit: Record<string, number> | null }>) {
    const dir = folder('stub');
    const script = join(dir, 'claude.mjs');
    copyFileSync(join(__dirname, '..', 'scripts', 'usage-on-switch-stub-claude.mjs'), script);
    writeFileSync(join(dir, 'status.json'), JSON.stringify(Object.fromEntries(Object.entries(status).map(([k, v]) => [k, { loggedIn: true, delayMs: 0, ...v }]))));
    const calls = (): Array<{ args: string[]; dir: string | null; probe: boolean }> => (existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    return { script, calls };
}
const run = (script: string, configDir: string | null, cwd: string, extra: { parentEnv?: Record<string, string | undefined> } = {}) =>
    readClaudeUsage({ configDir, cwd, binary: process.execPath, binaryArgs: [script], timeoutMs: 20_000, ...extra });

describe('readClaudeUsage: one tiny turn in the account\'s own folder', () => {
    it('returns that account\'s own windows, as Claude Code reported them', async () => {
        const acct = folder('acct');
        const s = standIn({ [acct]: { limit: { seven_day: 0.32 } } });
        const room = await run(s.script, acct, folder('cwd'));
        expect(room.windows.map((w) => [w.window, Math.round(w.usedPct)])).toEqual([['7d', 32]]);
    }, 30_000);

    it("runs in THAT folder, on the account's own default model, with no tools and nothing kept in history, one turn", async () => {
        const acct = folder('acct');
        const cwd = folder('cwd');
        const s = standIn({ [acct]: { limit: { seven_day: 0.32 } } });
        await run(s.script, acct, cwd);
        const launches = s.calls().filter((c) => c.args.includes('--print'));
        expect(launches).toHaveLength(1);
        const { args, dir } = launches[0]!;
        expect(dir).toBe(acct);
        // No model named: the account's own default (Tynn #608).
        expect(args).not.toContain('--model');
        expect(args).toContain('--no-session-persistence');
        expect(args[args.indexOf('--max-turns') + 1]).toBe('1');
        // No native tools; strict MCP with none; no inherited settings.
        expect(args[args.indexOf('--tools') + 1]).toBe('');
        expect(args).toContain('--strict-mcp-config');
        expect(args).not.toContain('--mcp-config');
        // Its working folder is left as it was found.
        expect(readdirSync(cwd)).toEqual([]);
    }, 30_000);

    it('the default home is `null`: an inherited CLAUDE_CONFIG_DIR is removed, so the CLI uses its own default', async () => {
        const s = standIn({ '': { limit: { seven_day: 0.12 } } });
        const room = await run(s.script, null, folder('cwd'), { parentEnv: { ...process.env, CLAUDE_CONFIG_DIR: '/someone/else' } });
        expect(s.calls().filter((c) => c.args.includes('--print')).map((c) => c.dir)).toEqual([null]);
        expect(room.windows.map((w) => Math.round(w.usedPct))).toEqual([12]);
    }, 30_000);

    it('a turn that reports no limit is a failure that says so, never a guessed figure', async () => {
        const acct = folder('acct');
        const s = standIn({ [acct]: { limit: null } });
        await expect(run(s.script, acct, folder('cwd'))).rejects.toThrow(/reported no usage/i);
    }, 30_000);

    it('a CLI that never answers is given up on at the time-out', async () => {
        // A script file, not `node -e`: node itself would read the CLI flags after `-e` as its own and refuse them.
        const hang = join(folder('hang'), 'hang.cjs');
        writeFileSync(hang, 'setInterval(() => {}, 1000);');
        const started = Date.now();
        await expect(readClaudeUsage({ configDir: folder('acct'), cwd: folder('cwd'), binary: process.execPath, binaryArgs: [hang], timeoutMs: 1_500 }))
            .rejects.toThrow(/did not answer/i);
        expect(Date.now() - started).toBeLessThan(10_000);
    }, 20_000);
});
