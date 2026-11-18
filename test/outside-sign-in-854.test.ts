import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Headroom, ReadingStamp } from '../src/core/headroom.js';
import { ReadingAttribution } from '../src/core/reading-attribution.js';
import { AccountIdentityReader } from '../src/main/account-identity.js';
import { AccountsHost } from '../src/main/accounts-host.js';
import { headroomArrival, IdentityWatch, identityReadHooks, IDENTITY_AFTER_READING_MS, IDENTITY_IDLE_MS } from '../src/main/identity-watch.js';
import type { ProviderHealthPorts } from '../src/main/provider-health.js';

/**
 * A SIGN-IN DONE OUTSIDE GENIE'S SWITCH (Tynn #854; the owner switched with /login in a TUI on beta.64 and Genie did not
 * notice). Genie read who is signed in only at start, after its OWN login or switch terminal, and on a health re-measure, so
 * a /login typed anywhere else left the chip, the popover and the Dashboard on the old account. Now Genie asks again, the
 * provider's own way (`claude auth status`, Codex `account/read`; never a credential file):
 *   - when a usage reading arrives and the identity was not read in the last minute: the read starts BEFORE the reading is
 *     stamped, so that reading is held and credited to the account actually signed in;
 *   - as an idle backstop, for a provider not read for five minutes.
 * Any read (Genie's own included) resets the clock. A change of account tells the windows, which re-read the accounts.
 * Fixtures name no person.
 */
const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');
const WORK = 'work@example.invalid';
const NEW = 'new@example.invalid';
const claudeStatus = (email: string) => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email });
const answer = (stdout: string) => ({ exitCode: 0, stdout, streams: { stdout, stderr: '' } });
const portsFor = (run: ProviderHealthPorts['run']): ProviderHealthPorts => ({
    platform: 'linux', arch: 'x64', env: { PATH: '/bin' }, isFile: (p) => p === '/bin/claude' || p === '/bin/codex', readText: () => '', readHead: () => null,
    realpath: (p) => p, chosen: () => null, now: () => 0, run,
});
const room = (leftPct: number): Headroom => ({ plan: null, window: '5h', leftPct, resetsAtMs: 9_999_999_999_999, over: false, windows: [] });

describe('a /login done outside Genie is noticed', () => {
    let dir = '';
    afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });

    /** Genie's host as composed: the real book, reader and attribution; only the provider's CLI answer is a stand-in. */
    async function rig() {
        dir = await mkdtemp(join(tmpdir(), 'genie-854-'));
        const book = await AccountsHost.open({ root: join(dir, 'genie'), legacyHomes: { claude: join(dir, 'claude-home'), codex: join(dir, 'codex-home') } });
        let signedInAs = WORK;
        let clock = 0;
        const run = vi.fn(async (binary: string) => answer(binary.endsWith('claude') ? claudeStatus(signedInAs) : ''));
        const attribution = new ReadingAttribution();
        const shown: Array<{ provider: string; stamp: ReadingStamp | undefined; leftPct: number }> = [];
        const offer = (provider: string, r: Headroom, stamp?: ReadingStamp) => { shown.push({ provider, stamp, leftPct: r.leftPct }); };
        let changed = 0;
        let watch: IdentityWatch | null = null;
        const reader = new AccountIdentityReader(book, () => portsFor(run), () => {}, identityReadHooks({
            attribution, activeId: (p) => book.activeFor(p).id, offer, changed: () => { changed += 1; }, read: (p) => watch?.read(p),
        }));
        // Only the reads the WATCH asks for are recorded: a test waits for those, and never starts one itself.
        const asked: Promise<void>[] = [];
        watch = new IdentityWatch({ refresh: (p) => { const read = reader.refreshProvider(p); asked.push(read); return read; }, now: () => clock });
        const arrive = headroomArrival({ watch, attribution, offer });
        await reader.refreshAll(); // Genie's start-up read, of every provider
        const claudeRuns = () => run.mock.calls.filter(([b]) => String(b).endsWith('claude')).length;
        return {
            book, reader, watch, arrive, shown, claudeRuns,
            changes: () => changed,
            asks: () => asked.length,
            settle: () => Promise.all(asked),
            at: (ms: number) => { clock = ms; },
            loginElsewhere: (email: string) => { signedInAs = email; },
        };
    }

    it('a reading after an outside /login re-reads who is signed in: the new account is active, and the reading is ITS', async () => {
        const r = await rig();
        const work = r.book.activeFor('claude');
        expect(work.identity.email).toBe(WORK);
        r.at(IDENTITY_AFTER_READING_MS + 1);
        r.loginElsewhere(NEW); // /login in a TUI: no Genie flow ran
        r.arrive('claude', room(97), { accountId: work.id, runId: 'run_1' });
        expect(r.asks()).toBe(1);
        await r.settle();
        const now = r.book.activeFor('claude');
        expect(now.identity.email).toBe(NEW);
        expect(r.changes()).toBe(1);
        // The reading was held through the read, then shown under the account found: never the old one's figure.
        expect(r.shown).toEqual([{ provider: 'claude', stamp: { accountId: now.id, runId: 'run_1', fresh: true }, leftPct: 97 }]);
    });

    it('CONTROL: within a minute of a read, readings do not ask again', async () => {
        const r = await rig();
        const before = r.claudeRuns();
        const work = r.book.activeFor('claude');
        r.at(IDENTITY_AFTER_READING_MS - 1);
        r.arrive('claude', room(50), { accountId: work.id, runId: 'run_1' });
        r.arrive('claude', room(49), { accountId: work.id, runId: 'run_1' });
        expect(r.asks()).toBe(0);
        expect(r.claudeRuns()).toBe(before);
        expect(r.shown.map((s) => s.stamp?.accountId)).toEqual([work.id, work.id]);
    });

    it('idle backstop: with no readings, a provider not read for five minutes is read again and an outside switch is found', async () => {
        const r = await rig();
        r.loginElsewhere(NEW);
        r.at(IDENTITY_IDLE_MS - 1);
        r.watch.tick();
        expect(r.asks()).toBe(0); // not due yet
        r.at(IDENTITY_IDLE_MS + 1);
        r.watch.tick();
        expect(r.asks()).toBe(2); // claude and codex
        await r.settle();
        expect(r.book.activeFor('claude').identity.email).toBe(NEW);
        expect(r.changes()).toBe(1);
    });

    it('any read resets the clock, Genie\'s own included', async () => {
        const r = await rig();
        r.at(IDENTITY_IDLE_MS - 10);
        await r.reader.refreshProvider('claude'); // e.g. after Genie's own login
        const before = r.claudeRuns();
        r.at(IDENTITY_IDLE_MS + 1);
        r.watch.tick();
        expect(r.asks()).toBe(1); // codex only: claude was read 11 ms ago
        expect(r.claudeRuns()).toBe(before);
    });

    it('the same account still signed in changes nothing and tells no window', async () => {
        const r = await rig();
        const work = r.book.activeFor('claude');
        r.at(IDENTITY_AFTER_READING_MS + 1);
        r.arrive('claude', room(80), { accountId: work.id, runId: 'run_1' });
        expect(r.asks()).toBe(1);
        await r.settle();
        expect(r.book.activeFor('claude').id).toBe(work.id);
        expect(r.changes()).toBe(0);
        expect(r.shown.map((s) => s.stamp?.accountId)).toEqual([work.id]);
    });
});

describe('genie-host composes it', () => {
    const host = source('src/main/genie-host.ts');
    it('readings go through headroomArrival, the reader\'s hooks are identityReadHooks, and a timer ticks the watch', () => {
        expect(host).toMatch(/onHeadroom: headroomArrival\(/);
        expect(host).toMatch(/new AccountIdentityReader\([^\n]*identityReadHooks\(/);
        expect(host).toMatch(/setInterval\(\(\) => \{ identityWatch\.tick\(\); \}/);
    });
    it('the watch reads no credential file: it only asks the reader', () => {
        const watch = source('src/main/identity-watch.ts');
        expect(watch).not.toMatch(/node:fs|credentials|auth\.json/);
    });
});
