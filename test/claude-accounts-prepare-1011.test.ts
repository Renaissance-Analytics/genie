import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ClaudeSharedSessionsRefusal } from '@particle-academy/prism-acp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { AccountsHost } from '../src/main/accounts-host.js';
import { prepareAccountDir, SHARED_SESSIONS_REFUSALS, sharedSessionsWords, syncCleanupPeriod } from '../src/main/claude-account-dirs.js';
import { realDriverFor } from '../src/main/session-host.js';

/**
 * PRISM-ACP 0.46.0 (Tynn #1011, #1014). The shared session store is prism-acp's own now (`claudeAccounts.prepare(configDir,
 * { sharedSessions: true })`), with typed refusals Genie says in its own words. Its caveat: Claude Code prunes transcripts older
 * than `cleanupPeriodDays` under `projects/` whichever account is active, so in a SHARED store the shortest setting among the
 * accounts prunes everyone's: each directory Genie makes carries the default account's value. And every Claude launch has
 * Remote Control forced off (`disableRemoteControl`), which Genie's launches must carry.
 */
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-1011-prepare-')); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

describe('prepareAccountDir: prism-acp\'s prepare, the one place an account directory is made ready', () => {
    it('makes the directory and links its projects to the store; a second call finds it done', async () => {
        const store = join(dir, 'home', '.claude', 'projects'), account = join(dir, 'genie', 'accounts', 'claude', 'a');
        expect(prepareAccountDir(account, store)).toEqual({ ok: true });
        expect((await lstat(join(account, 'projects'))).isSymbolicLink()).toBe(true);
        expect(resolve(await readlink(join(account, 'projects')))).toBe(resolve(store));
        expect(prepareAccountDir(account, store)).toEqual({ ok: true });
    });

    it('refuses an account folder with its own history, in Genie\'s words, and leaves it as it is', async () => {
        const store = join(dir, 'store'), account = join(dir, 'acct');
        await mkdir(join(account, 'projects'), { recursive: true });
        await writeFile(join(account, 'projects', 'keep.jsonl'), 'history');
        const r = prepareAccountDir(account, store);
        expect(r).toEqual({ ok: false, code: 'realFolder', reason: sharedSessionsWords('realFolder') });
        expect((await lstat(join(account, 'projects'))).isSymbolicLink()).toBe(false);
        expect(await readFile(join(account, 'projects', 'keep.jsonl'), 'utf8')).toBe('history');
    });

    it('every refusal prism-acp can give has words of Genie\'s own, distinct, naming no path', () => {
        const all: readonly ClaudeSharedSessionsRefusal[] = ['realFolder', 'linkedElsewhere', 'occupied', 'unexpectedLink', 'storeMissing', 'storeInvalid', 'configDirInvalid', 'linkFailed'];
        expect([...SHARED_SESSIONS_REFUSALS].sort()).toEqual([...all].sort());
        const words = all.map(sharedSessionsWords);
        expect(new Set(words).size).toBe(all.length);
        for (const w of words) { expect(w.length).toBeGreaterThan(20); expect(w).not.toMatch(/[\\/]/); }
    });
});

describe('cleanupPeriodDays: one value for every account that shares the store, the default account\'s', () => {
    const home = () => join(dir, 'home', '.claude');
    const acct = () => join(dir, 'acct');
    const settings = async (p: string) => JSON.parse(await readFile(join(p, 'settings.json'), 'utf8')) as Record<string, unknown>;

    it('copies the default account\'s cleanupPeriodDays, and ONLY it', async () => {
        await mkdir(home(), { recursive: true }); await mkdir(acct(), { recursive: true });
        await writeFile(join(home(), 'settings.json'), JSON.stringify({ cleanupPeriodDays: 90, env: { SOME_TOKEN: 'never-copied' }, apiKeyHelper: 'never-copied' }));
        syncCleanupPeriod(acct(), home());
        expect(await settings(acct())).toEqual({ cleanupPeriodDays: 90 });
    });

    it('with none set on the default account, writes Claude Code\'s default (30): no account prunes sooner by omission', async () => {
        await mkdir(acct(), { recursive: true });
        syncCleanupPeriod(acct(), home());
        expect(await settings(acct())).toEqual({ cleanupPeriodDays: 30 });
    });

    it('keeps the account\'s own other settings, and follows the default when it changes', async () => {
        await mkdir(home(), { recursive: true }); await mkdir(acct(), { recursive: true });
        await writeFile(join(acct(), 'settings.json'), JSON.stringify({ model: 'kept', cleanupPeriodDays: 7 }));
        await writeFile(join(home(), 'settings.json'), JSON.stringify({ cleanupPeriodDays: 60 }));
        syncCleanupPeriod(acct(), home());
        expect(await settings(acct())).toEqual({ model: 'kept', cleanupPeriodDays: 60 });
        await writeFile(join(home(), 'settings.json'), JSON.stringify({ cleanupPeriodDays: 120 }));
        syncCleanupPeriod(acct(), home());
        expect((await settings(acct())).cleanupPeriodDays).toBe(120);
    });

    it('a default value that is not a positive whole number is not copied: Claude Code\'s default stands', async () => {
        await mkdir(home(), { recursive: true }); await mkdir(acct(), { recursive: true });
        await writeFile(join(home(), 'settings.json'), JSON.stringify({ cleanupPeriodDays: '9; rm -rf' }));
        syncCleanupPeriod(acct(), home());
        expect((await settings(acct())).cleanupPeriodDays).toBe(30);
    });

    it('an account Genie adds gets it from the start', async () => {
        await mkdir(home(), { recursive: true });
        await writeFile(join(home(), 'settings.json'), JSON.stringify({ cleanupPeriodDays: 45 }));
        const book = await AccountsHost.open({ root: join(dir, 'genie'), legacyHomes: { claude: home(), codex: join(dir, 'home', '.codex') } });
        const added = await book.addClaude({ method: 'console' });
        expect((await settings(added.configDir!)).cleanupPeriodDays).toBe(45);
        // And the host keeps every account it made in step (at its start): the default changed, the account follows.
        await writeFile(join(home(), 'settings.json'), JSON.stringify({ cleanupPeriodDays: 14 }));
        book.syncClaudeDirs();
        expect((await settings(added.configDir!)).cleanupPeriodDays).toBe(14);
    });
});

describe('Remote Control is off on every Claude launch Genie makes (Tynn #1014, prism-acp 0.46.0)', () => {
    it('the real launch carries --settings with disableRemoteControl, and never a remote-control flag', async () => {
        if (process.platform === 'win32') return; // the recorder is a POSIX script; the rule is the same code path
        const seen = join(dir, 'argv.json');
        const recorder = join(dir, 'claude-recorder.cjs');
        // The recorder reads a --settings FILE at once: prism-acp removes its private launch folder when the CLI has gone.
        writeFileSync(recorder, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
const at = argv.indexOf('--settings');
let settings = null;
if (at >= 0) { const v = argv[at + 1] || ''; try { settings = v.trim().startsWith('{') ? v : fs.readFileSync(v, 'utf8'); } catch (e) { settings = 'unreadable: ' + e.message; } }
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv, settings }));
`);
        chmodSync(recorder, 0o755);
        vi.stubEnv('GENIE2_CLAUDE_BINARY', recorder);
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'probe' });
        const account = { id: `account_${'9'.repeat(32)}`, provider: 'claude' as const, label: 'X', labelEdited: false, home: join(dir, 'h'), legacy: false,
            identity: { name: null, email: null, plan: null }, createdAt: '2026-11-21T00:00:00Z', configDir: join(dir, 'own'), method: 'subscription' as const };
        const factory = realDriverFor(record, dir, null, { account });
        expect(factory).not.toBeNull();
        const driver = factory!({ events: {} } as never);
        try { driver.start(); } catch { /* the recorder exits at once; the argv is what is measured */ }
        await vi.waitFor(() => expect(existsSync(seen)).toBe(true), { timeout: 15_000 });
        try { driver.kill?.(); } catch { /* gone */ }
        const { argv, settings } = JSON.parse(readFileSync(seen, 'utf8')) as { argv: string[]; settings: string | null };
        expect(argv).toContain('--settings');
        // Inline JSON, or a settings file of the launch's own (read by the CLI stand-in as it started): the forced key is in it.
        expect(settings).not.toBeNull();
        expect(JSON.parse(settings!)).toMatchObject({ disableRemoteControl: true });
        expect(argv.join(' ')).not.toMatch(/remote-control|--remote\b|--teleport|--cloud/);
    });
});
