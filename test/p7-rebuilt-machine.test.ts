import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { resolveDeckAnswer } from '../src/core/deck-resolve.js';
import { workstationKeyStore } from '../src/main/workstation-identity.js';
import { fakeKeychain } from './helpers/tynn-storage.js';

/**
 * P7.3 — ATTACH TO A REBUILT MACHINE (`.ai/plans/genie-2-host-split-2026-10-31.md`, "P7 build spec: one data root", item 3;
 * Tynn #419). The parts, each on its own; test/p7-rebuild-real-host.test.ts starts a real genie-host on a root put back.
 *
 *  1. THE ATTACH (data-root.ts): how a start finds its root — first, the same machine, the machine files gone, another
 *     machine's — and that another machine's machine files are moved away before anything reads them, every one of them.
 *  2. WHAT COULD NOT BE RESTORED (core/attach-report.ts): one item per secret the root points at and the keychain no
 *     longer holds, each with its action; what the host made again and what never was in the root, said once.
 *  3. THE HOST'S RECORD OF IT (attach-host.ts): presence only, standing items that go when the thing is back, Dismiss kept.
 *  4. THIS MACHINE REGISTERED AGAIN (workstation-identity.ts), against a Tynn that answers each way; never with a proof.
 *  5. THE AGENTS' LOST KEYS (tynn-agent-identities.ts): taken off record so the next start mints one; a key that is
 *     there, or that could not be read, is never replaced.
 */

type AttachKind = 'first' | 'same' | 'machine-files-gone' | 'another-machine';
interface Rule { readonly path: string; readonly kind: 'state' | 'machine'; readonly live?: true; readonly atStart?: boolean }
interface DataRootModule {
    DATA_ROOT_RULES: readonly Rule[];
    MACHINE_MARK_FILE: string;
    machineMarkOf(rawId: string | null): string | null;
    dataRootManifest(build: string, writtenOn?: string | null): { writtenOn: string | null; format: number; build: string };
    attachDataRoot(home: string, options: { build: string; machine: string | null; now?: () => number; log?: (line: string) => void }): Promise<{ kind: AttachKind; moved: readonly string[]; notRemoved: readonly string[]; swept: Promise<void> }>;
}
interface AttachItem { readonly id: string; readonly title: string; readonly detail: string; readonly action: { readonly id: string; readonly label: string } | null; readonly standing: boolean }
interface AttachFacts {
    attach: AttachKind; keychainAnswers: boolean;
    tynn: { onRecord: boolean; held: boolean; signedIn: boolean }; github: { login: string | null; held: boolean };
    agentKeys: { onRecord: number; missing: number }; workstation: { recordedId: string | null; held: boolean };
    devices: Array<{ url: string; held: boolean }>; remade: { mailInboxes: number; proofKey: boolean };
    sites: number; engines: number; tynnWorkstationsUrl: string; notRemoved: string[];
}
interface ReportModule {
    ATTACH_DECK_PREFIX: string;
    ATTACH_WORDS: Record<string, string>;
    attachItems(facts: AttachFacts): AttachItem[];
    attachDeckItem(item: AttachItem, at: number): DeckItem;
    attachAnswer(optionId: string): { kind: 'act'; action: string } | { kind: 'dismiss' } | null;
}
type RegisterAgain = { ok: true; outcome: 'same' | 'new'; workstationId: string } | { ok: false; reason: string };
interface AttachSources {
    tynn: () => { onRecord: boolean; signedIn: boolean } | null; githubLogin: () => string | null; agentKeyIds: () => Promise<readonly string[]>;
    workstation: () => Promise<{ id: string | null; secret: string }>; deviceUrls: () => readonly string[]; sites: () => number; engines: () => number; tynnWorkstationsUrl: string;
    act: { tynnSignIn(): Promise<void>; githubSignIn(): Promise<void>; agentKeys(): Promise<{ ok: true; made: number } | { ok: false; reason: string }>; workstationRegister(): Promise<RegisterAgain> };
}
interface AttachHostInstance { noteProofKeyMade(): Promise<void>; wire(sources: AttachSources): Promise<void>; refresh(): Promise<void>; view(): readonly AttachItem[]; items(): DeckItem[]; onChange(l: () => void): () => void; answer(id: string, optionId: string): Promise<void> }
interface AttachHostModule {
    AttachHost: { open(ports: { file: string; attach: { kind: AttachKind; notRemoved: readonly string[] }; secrets: unknown; mailInboxIds: () => Promise<readonly string[]>; now?: () => number; log?: (line: string) => void }): Promise<AttachHostInstance> };
}
interface IdentityModule {
    registerWorkstationAgain(ports: { host: () => string; hostname: () => string; request: (path: string, init: { method: 'GET' | 'POST'; body?: unknown }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>; store: unknown; machineKey?: () => Promise<string | null> }): Promise<RegisterAgain>;
}
interface AgentIdentitiesModule { tynnAgentIdentities(ports: { file: string; secrets: unknown }): { lostKeys: { ids(): Promise<string[]>; forget(): Promise<number> } } }

// Loaded by a path the type checker does not follow, so each row fails on its own while a part is not there.
const load = <T>(path: string): Promise<T> => import(path) as Promise<T>;
const dataRoot = (): Promise<DataRootModule> => load('../src/main/data-root.js');
const report = (): Promise<ReportModule> => load('../src/core/attach-report.js');
const attachHost = (): Promise<AttachHostModule> => load('../src/main/attach-host.js');
const identity = (): Promise<IdentityModule> => load('../src/main/workstation-identity.js');
const agentIdentities = (): Promise<AgentIdentitiesModule> => load('../src/main/tynn-agent-identities.js');

const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
const put = (home: string, relative: string, text = 'x'): string => { const file = join(home, ...relative.split('/')); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); return file; };
const at = (home: string, relative: string): string => join(home, ...relative.replace(/\/$/, '').split('/'));
const manifestOf = (home: string): { writtenOn: string | null; build: string } => JSON.parse(readFileSync(join(home, 'data-root.json'), 'utf8')) as { writtenOn: string | null; build: string };

// --- 1. THE ATTACH ----------------------------------------------------------------------------------------------------------

describe('this machine, as the manifest names it', () => {
    it('is a hash of the OS machine id: the same for the same id however it is written, another for another, and never the id', async () => {
        const { machineMarkOf } = await dataRoot();
        const id = '4c4c4544-0042-3510-8054-b9c04f4a3332';
        const mark = machineMarkOf(id);
        expect(mark).toMatch(/^[0-9a-f]{64}$/);
        expect(machineMarkOf(`  ${id.toUpperCase()}\n`)).toBe(mark);
        expect(machineMarkOf('4c4c4544-0042-3510-8054-b9c04f4a3333')).not.toBe(mark);
        expect(mark).not.toContain(id.replace(/-/g, '').slice(0, 12));
        expect(machineMarkOf(null)).toBeNull();
        expect(machineMarkOf('  ')).toBeNull();
    });
});

describe('the attach: how a start finds its root', () => {
    const A = 'a'.repeat(64);
    const B = 'b'.repeat(64);

    it('FIRST: an empty root. The manifest names this machine, and the mark is beside the machine files', async () => {
        const { attachDataRoot, MACHINE_MARK_FILE } = await dataRoot();
        const home = temp('genie-p7-attach-first-');
        const r = await attachDataRoot(home, { build: 'b1', machine: A });
        expect(r).toMatchObject({ kind: 'first', moved: [], notRemoved: [] });
        expect(manifestOf(home)).toMatchObject({ writtenOn: A, build: 'b1' });
        expect(JSON.parse(readFileSync(at(home, MACHINE_MARK_FILE), 'utf8'))).toEqual({ machine: A });
    });

    it('FIRST too: a root an older Genie wrote (a manifest that names no machine, machine files all there). Nothing is moved', async () => {
        const { attachDataRoot } = await dataRoot();
        const home = temp('genie-p7-attach-older-');
        put(home, 'data-root.json', JSON.stringify({ format: 1, build: 'older', state: [], machine: [] }));
        put(home, 'runtime/children.json', '{"records":[]}');
        put(home, 'runtime/agents.json', '[]');
        const r = await attachDataRoot(home, { build: 'b2', machine: A });
        expect(r).toMatchObject({ kind: 'first', moved: [] });
        expect(existsSync(at(home, 'runtime/children.json'))).toBe(true);
        expect(manifestOf(home).writtenOn).toBe(A);
    });

    it('SAME: the next start on the same machine moves nothing', async () => {
        const { attachDataRoot } = await dataRoot();
        const home = temp('genie-p7-attach-same-');
        await attachDataRoot(home, { build: 'b1', machine: A });
        put(home, 'runtime/children.json', '{"records":[]}');
        const r = await attachDataRoot(home, { build: 'b2', machine: A });
        expect(r).toMatchObject({ kind: 'same', moved: [], notRemoved: [] });
        expect(existsSync(at(home, 'runtime/children.json'))).toBe(true);
        expect(manifestOf(home).build).toBe('b2');
    });

    it('MACHINE FILES GONE: the state and the manifest were put back, the machine files were not. The mark is made again', async () => {
        const { attachDataRoot, MACHINE_MARK_FILE } = await dataRoot();
        const home = temp('genie-p7-attach-gone-');
        await attachDataRoot(home, { build: 'b1', machine: A });
        put(home, 'runtime/agents.json', '[{"id":"a1"}]');
        rmSync(at(home, MACHINE_MARK_FILE));
        const r = await attachDataRoot(home, { build: 'b1', machine: A });
        expect(r).toMatchObject({ kind: 'machine-files-gone', moved: [] });
        expect(readFileSync(at(home, 'runtime/agents.json'), 'utf8')).toBe('[{"id":"a1"}]');
        expect(existsSync(at(home, MACHINE_MARK_FILE))).toBe(true);
        // And the start after it is an ordinary one.
        expect((await attachDataRoot(home, { build: 'b1', machine: A })).kind).toBe('same');
    });

    it('ANOTHER MACHINE: the whole root came from elsewhere. Its machine files are moved away, the state and what a running Genie holds stay, and the moved are deleted after', async () => {
        const { attachDataRoot, MACHINE_MARK_FILE } = await dataRoot();
        const home = temp('genie-p7-attach-other-');
        await attachDataRoot(home, { build: 'b1', machine: A });
        const state = { 'runtime/agents.json': '[{"id":"a1"}]', 'credentials/tynn.json': '{"userId":"u1"}', 'runtime/gen-ca/ca.key': 'KEY', 'runtime/sessions/abc.jsonl': '{"n":1}\n', 'runtime/engine-run-state.json': '{"stopped":["pg"]}' };
        const machine = ['runtime/children.json', 'runtime/ptys.json', 'runtime/safe-mode.json', 'runtime/alive.json', 'runtime/crash/2026.json', 'genie2-toolchain/php-versions/8.4/php', 'mcp-endpoint.json',
            'runtime/host-proxy.json', 'runtime/mobile-tls/key.pem', 'runtime/provider-programs.json', 'runtime/host.json', 'runtime/host.token', 'runtime/caddy/Caddyfile', 'runtime/attach-report.json'];
        const live = ['logs/genie-host.log', 'runtime/lifecycle.log', 'runtime/host.sock', 'host/runtime-39.0.0/.complete', 'cache/tmp/1-1/a.txt', 'runtime/genie.pid'];
        for (const [p, text] of Object.entries(state)) put(home, p, text);
        for (const p of [...machine, ...live]) put(home, p, `of machine A: ${p}`);
        // CONTROL: they are all there before.
        for (const p of machine) expect(existsSync(at(home, p)), p).toBe(true);

        const lines: string[] = [];
        const r = await attachDataRoot(home, { build: 'b1', machine: B, now: () => 1_700_000_000_000, log: (l) => lines.push(l) });
        expect(r.kind).toBe('another-machine');
        expect(r.notRemoved).toEqual([]);
        for (const p of machine) expect(existsSync(at(home, p)), p).toBe(false);
        for (const [p, text] of Object.entries(state)) expect(readFileSync(at(home, p), 'utf8'), p).toBe(text);
        for (const p of live) expect(readFileSync(at(home, p), 'utf8'), p).toBe(`of machine A: ${p}`);
        expect(r.moved).toEqual(expect.arrayContaining(['runtime/children.json', 'genie2-toolchain/', 'runtime/crash/', 'mcp-endpoint.json']));
        expect(lines.join('\n')).toMatch(/data root: another-machine; moved away \d+ of another machine's/);
        // Written for THIS machine now.
        expect(manifestOf(home).writtenOn).toBe(B);
        expect(JSON.parse(readFileSync(at(home, MACHINE_MARK_FILE), 'utf8'))).toEqual({ machine: B });
        await r.swept;
        expect(readdirSync(join(home, 'cache')).filter((n) => n.startsWith('stale-'))).toEqual([]);
        expect(existsSync(at(home, 'cache/tmp/1-1/a.txt'))).toBe(true);
        expect((await attachDataRoot(home, { build: 'b1', machine: B })).kind).toBe('same');
    });

    it('ANOTHER MACHINE by the mark alone: the state is this machine’s, the machine files were copied in from another', async () => {
        const { attachDataRoot, MACHINE_MARK_FILE } = await dataRoot();
        const home = temp('genie-p7-attach-mark-');
        await attachDataRoot(home, { build: 'b1', machine: A });
        put(home, MACHINE_MARK_FILE, JSON.stringify({ machine: B }));
        put(home, 'runtime/children.json', '{}');
        const r = await attachDataRoot(home, { build: 'b1', machine: A });
        expect(r.kind).toBe('another-machine');
        expect(existsSync(at(home, 'runtime/children.json'))).toBe(false);
    });

    it('EVERY machine rule is moved away from another machine’s root, or is one a running Genie holds: none is left to be read as this machine’s', async () => {
        const { attachDataRoot, DATA_ROOT_RULES } = await dataRoot();
        const home = temp('genie-p7-attach-every-');
        await attachDataRoot(home, { build: 'b1', machine: A });
        const rules = DATA_ROOT_RULES.filter((r) => r.kind === 'machine');
        for (const r of rules) put(home, r.path.endsWith('/') ? `${r.path}inside.txt` : r.path, 'of machine A');
        const r = await attachDataRoot(home, { build: 'b1', machine: B });
        expect(r.notRemoved).toEqual([]);
        const held = rules.filter((x) => x.live === true).map((x) => x.path);
        // What is rewritten for this machine by the attach itself is there again, as this machine's.
        const rewritten = new Set(['runtime/machine.json']);
        expect(rules.filter((x) => x.live !== true && !rewritten.has(x.path) && existsSync(at(home, x.path))).map((x) => x.path)).toEqual([]);
        expect(held.filter((p) => !existsSync(at(home, p)))).toEqual([]);
        // CONTROL: both kinds exist, and the live ones are the few named for a reason.
        expect(held.sort()).toEqual(['cache/', 'host/', 'logs/', 'runtime/doctor-hold.json', 'runtime/genie.pid', 'runtime/host.sock', 'runtime/lifecycle.log']);
        expect(rules.length - held.length).toBeGreaterThan(25);
        // No state rule is ever live or moved.
        expect(DATA_ROOT_RULES.filter((x) => x.kind === 'state' && x.live !== undefined).map((x) => x.path)).toEqual([]);
    });

    it('A MACHINE ID THE OS DID NOT GIVE never judges the root another machine’s, and keeps the machine last named', async () => {
        const { attachDataRoot, MACHINE_MARK_FILE } = await dataRoot();
        const home = temp('genie-p7-attach-noid-');
        await attachDataRoot(home, { build: 'b1', machine: A });
        put(home, 'runtime/children.json', '{}');
        const r = await attachDataRoot(home, { build: 'b1', machine: null });
        expect(r).toMatchObject({ kind: 'same', moved: [] });
        expect(manifestOf(home).writtenOn).toBe(A);
        rmSync(at(home, MACHINE_MARK_FILE));
        expect((await attachDataRoot(home, { build: 'b1', machine: null })).kind).toBe('machine-files-gone');
        // Readable again and it is another machine after all: said then.
        expect((await attachDataRoot(home, { build: 'b1', machine: B })).kind).toBe('another-machine');
    });
});

// --- 2. WHAT COULD NOT BE RESTORED ------------------------------------------------------------------------------------------

const allThere: AttachFacts = {
    attach: 'same', keychainAnswers: true,
    tynn: { onRecord: true, held: true, signedIn: true }, github: { login: 'octo', held: true },
    agentKeys: { onRecord: 2, missing: 0 }, workstation: { recordedId: 'ws_1', held: true },
    devices: [{ url: 'wss://desk.tail/ws', held: true }], remade: { mailInboxes: 0, proofKey: false },
    sites: 2, engines: 1, tynnWorkstationsUrl: 'https://tynn.ai/account/workstations', notRemoved: [],
};
const gone: AttachFacts = {
    ...allThere, attach: 'machine-files-gone',
    tynn: { onRecord: true, held: false, signedIn: false }, github: { login: 'octo', held: false },
    agentKeys: { onRecord: 2, missing: 2 }, workstation: { recordedId: 'ws_1', held: false },
    devices: [{ url: 'wss://desk.tail/ws', held: false }, { url: 'wss://lap.tail/ws', held: true }], remade: { mailInboxes: 2, proofKey: true },
};

describe('what could not be restored, in items', () => {
    it('nothing missing on the same machine: nothing is said', async () => {
        const { attachItems } = await report();
        expect(attachItems(allThere)).toEqual([]);
        // Nothing on record is nothing missing either: a Genie that never signed in is not asked to sign in AGAIN.
        expect(attachItems({ ...allThere, tynn: { onRecord: false, held: false, signedIn: false }, github: { login: null, held: false }, workstation: { recordedId: null, held: false }, devices: [], agentKeys: { onRecord: 0, missing: 0 } })).toEqual([]);
    });

    it('EVERY MISSING SECRET IS AN ITEM WITH WHAT TO DO: Tynn first, then GitHub, the agents’ keys, this machine, the paired machines', async () => {
        const { attachItems, ATTACH_DECK_PREFIX } = await report();
        const items = attachItems(gone);
        expect(items.map((i) => i.id.slice(ATTACH_DECK_PREFIX.length))).toEqual(['tynn', 'github', 'agent-keys', 'workstation', 'devices', 'remade', 'machine']);
        const by = (key: string): AttachItem => items.find((i) => i.id === `${ATTACH_DECK_PREFIX}${key}`)!;
        expect(by('tynn')).toMatchObject({ title: 'Sign in to Tynn again', action: { id: 'tynn-sign-in', label: 'Open Tynn in your browser' }, standing: true });
        expect(by('github')).toMatchObject({ title: 'Sign in to GitHub again', action: { id: 'github-sign-in' }, standing: true });
        expect(by('github').detail).toContain('octo');
        expect(by('agent-keys')).toMatchObject({ title: '2 agents’ Tynn keys are not in this computer’s keychain', action: { id: 'agent-keys', label: 'Make new keys' }, standing: true });
        expect(by('agent-keys').detail).toContain('Sign in to Tynn first');
        expect(by('workstation')).toMatchObject({ title: 'Register this machine with Tynn again', action: { id: 'workstation-register', label: 'Register this machine again' }, standing: true });
        // It says, before the click, what registering again may drop, and where Tynn lists it.
        expect(by('workstation').detail).toContain('permission to drive your other machines is removed until you approve it again in Tynn (it asks for your 2FA code)');
        expect(by('workstation').detail).toContain('its share links and paired devices must be made again, and the old entry stays in Tynn’s list until you delete it there');
        expect(by('workstation').detail).toContain('https://tynn.ai/account/workstations');
        // Only the machine whose pairing is gone, and no action Genie could take for it: the PIN is on that machine.
        expect(by('devices')).toMatchObject({ title: 'Pair again with 1 machine', action: null, standing: true });
        expect(by('devices').detail).toContain('wss://desk.tail/ws');
        expect(by('devices').detail).not.toContain('wss://lap.tail/ws');
    });

    it('one agent reads as one; a signed-in Tynn is not told to sign in first', async () => {
        const { attachItems } = await report();
        const items = attachItems({ ...gone, tynn: { onRecord: true, held: true, signedIn: true }, agentKeys: { onRecord: 2, missing: 1 } });
        expect(items.some((i) => i.title === 'Sign in to Tynn again')).toBe(false);
        const keys = items.find((i) => i.action?.id === 'agent-keys')!;
        expect(keys.title).toBe('1 agent’s Tynn key is not in this computer’s keychain');
        expect(keys.detail).not.toContain('Sign in to Tynn first');
        expect(items.find((i) => i.action?.id === 'workstation-register')!.detail).not.toContain('Sign in to Tynn first');
    });

    it('A KEYCHAIN THAT DOES NOT ANSWER is not an empty one: nothing is called missing (the keyring card says that)', async () => {
        const { attachItems } = await report();
        expect(attachItems({ ...gone, attach: 'same', keychainAnswers: false, remade: { mailInboxes: 0, proofKey: false } })).toEqual([]);
    });

    it('MADE AGAIN and NOT RESTORED are said once, on a rebuilt machine only: the keys Genie remade, the installs outside the root, the databases’ data', async () => {
        const { attachItems, ATTACH_DECK_PREFIX } = await report();
        const quiet = { ...allThere, remade: { mailInboxes: 2, proofKey: true } };
        expect(attachItems(quiet)).toEqual([]);
        for (const attach of ['machine-files-gone', 'another-machine'] as const) {
            const items = attachItems({ ...quiet, attach });
            expect(items.map((i) => i.id.slice(ATTACH_DECK_PREFIX.length))).toEqual(['remade', 'machine']);
            expect(items.every((i) => !i.standing && i.action === null)).toBe(true);
            expect(items[0]!.detail).toContain('2 mail inboxes');
            expect(items[0]!.detail).toContain('proof-of-done');
            expect(items[1]!.detail).toMatch(/certificate.*hosts file.*PATH.*firewall rule/);
            expect(items[1]!.detail).toContain('Check and repair');
            expect(items[1]!.detail).toContain('NOT restored: the data inside 1 service engine');
            expect(items[1]!.detail).toContain('Docker’s volumes, which never were in Genie’s data');
            expect(items[0]!.detail.startsWith(attach === 'another-machine' ? 'This Genie’s data was moved here from another machine.' : 'This Genie’s data was put back on a rebuilt machine.')).toBe(true);
        }
        // No sites and no engines: no machine set-up to speak of. No engines: nothing is said about their data.
        expect(attachItems({ ...allThere, attach: 'machine-files-gone', sites: 0, engines: 0 })).toEqual([]);
        expect(attachItems({ ...allThere, attach: 'machine-files-gone', sites: 1, engines: 0 })[0]!.detail).not.toContain('NOT restored');
        // What the attach could not move away is said too.
        expect(attachItems({ ...allThere, attach: 'another-machine', sites: 0, engines: 0, notRemoved: ['genie2-toolchain/ (EBUSY)'] }).map((i) => i.detail).join(' ')).toContain('genie2-toolchain/ (EBUSY)');
    });

    it('NEVER THE RETIRED NAMES: no item says Pilot or Drone (the owner, 2026-11-18); it says the effect', async () => {
        const { attachItems, ATTACH_WORDS } = await report();
        const words = [...attachItems(gone).flatMap((i) => [i.title, i.detail, i.action?.label ?? '']), ...Object.values(ATTACH_WORDS)].join('\n');
        expect(words).not.toMatch(/\b(pilot|drone)s?\b/i);
        // CONTROL: the words are there to be searched.
        expect(words).toContain('2FA code');
        expect(ATTACH_WORDS['workstationNew']).toBe('Tynn does not recognise this machine, so it is registered as a new workstation: its share links and paired devices must be made again, and the old entry stays in Tynn’s list until you delete it there.');
        expect(ATTACH_WORDS['workstationSame']).toContain('This machine’s permission to drive your other machines is removed until you approve it again in Tynn (it asks for your 2FA code).'.replace('This machine’s', 'Its'));
    });

    it('ON THE DECK: Genie’s own item, its action then Dismiss; the answer is the action, a Dismiss, or nothing Genie knows', async () => {
        const { attachItems, attachDeckItem, attachAnswer } = await report();
        const items = attachItems(gone);
        const tynn = attachDeckItem(items[0]!, 42);
        expect(tynn).toMatchObject({ id: items[0]!.id, source: 'genie', agentId: null, blocking: false, at: 42, title: 'Sign in to Tynn again', detail: items[0]!.detail });
        expect(tynn.answer).toEqual({ kind: 'inline', options: [{ id: 'tynn-sign-in', label: 'Open Tynn in your browser', tone: 'ok' }, { id: 'dismiss', label: 'Dismiss', tone: 'neutral' }] });
        const devices = attachDeckItem(items.find((i) => i.action === null)!, 42);
        expect(devices.answer).toEqual({ kind: 'inline', options: [{ id: 'dismiss', label: 'Dismiss', tone: 'neutral' }] });
        expect(attachAnswer('dismiss')).toEqual({ kind: 'dismiss' });
        expect(attachAnswer('workstation-register')).toEqual({ kind: 'act', action: 'workstation-register' });
        expect(attachAnswer('trust')).toBeNull();
        // The Deck's own resolver sends an answer to it here, with the option the person picked.
        expect(resolveDeckAnswer(tynn, 'tynn-sign-in')).toEqual({ kind: 'attach', id: tynn.id, optionId: 'tynn-sign-in' });
        expect(resolveDeckAnswer(tynn, 'dismiss')).toEqual({ kind: 'attach', id: tynn.id, optionId: 'dismiss' });
    });
});

// --- 3. THE HOST'S RECORD ---------------------------------------------------------------------------------------------------

const SECRET = 'sk-THIS-IS-A-SECRET-VALUE-0123456789';
function sourcesOf(over: Partial<AttachSources> = {}): AttachSources & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        tynn: () => ({ onRecord: true, signedIn: false }),
        githubLogin: () => 'octo',
        agentKeyIds: async () => ['01AAAAAAAAAAAAAAAAAAAAAAAA', '01BBBBBBBBBBBBBBBBBBBBBBBB'],
        workstation: async () => ({ id: 'ws_1', secret: 'workstation/https://tynn.ai' }),
        deviceUrls: () => ['wss://desk.tail/ws'],
        sites: () => 1,
        engines: () => 1,
        tynnWorkstationsUrl: 'https://tynn.ai/account/workstations',
        act: {
            tynnSignIn: async () => { calls.push('tynnSignIn'); },
            githubSignIn: async () => { calls.push('githubSignIn'); },
            agentKeys: async () => { calls.push('agentKeys'); return { ok: true, made: 2 }; },
            workstationRegister: async () => { calls.push('workstationRegister'); return { ok: true, outcome: 'new', workstationId: 'ws_2' }; },
        },
        ...over,
    };
}
const keys = (items: readonly AttachItem[]): string[] => items.map((i) => i.id.replace('genie:attach:', ''));

describe('the host’s record of what it could not restore', () => {
    const open = async (kind: AttachKind, secrets: unknown, file = join(temp('genie-p7-report-'), 'runtime', 'attach-report.json'), mail: string[] = ['in1', 'in2', 'in3']) => {
        const { AttachHost } = await attachHost();
        return { file, host: await AttachHost.open({ file, attach: { kind, notRemoved: [] }, secrets, mailInboxIds: async () => mail, now: () => 1000 }) };
    };

    it('says nothing before the accounts are there, then one item per thing the keychain does not hold; a thing it holds is not one', async () => {
        const chain = fakeKeychain({ 'github/access': SECRET, 'tynn/agent/01BBBBBBBBBBBBBBBBBBBBBBBB': SECRET });
        const { host } = await open('machine-files-gone', chain);
        expect(host.items()).toEqual([]);
        await host.wire(sourcesOf());
        expect(keys(host.view())).toEqual(['tynn', 'agent-keys', 'workstation', 'devices', 'remade', 'machine']);
        expect(host.view().find((i) => i.id.endsWith('agent-keys'))!.title).toContain('1 agent’s Tynn key is');
        expect(host.items().map((i) => i.id)).toEqual(host.view().map((i) => i.id));
        expect(host.items()[0]).toMatchObject({ source: 'genie', at: 1000 });
    });

    it('ON A REBUILT MACHINE it notes, before anything makes them again, the mail passwords that are gone; and the signing key when a new one is made', async () => {
        const chain = fakeKeychain({ 'mail/inbox/in2': SECRET });
        const { host, file } = await open('machine-files-gone', chain);
        await host.wire(sourcesOf({ tynn: () => ({ onRecord: false, signedIn: false }), githubLogin: () => null, agentKeyIds: async () => [], workstation: async () => ({ id: null, secret: 'workstation/x' }), deviceUrls: () => [] }));
        expect(host.view().find((i) => i.id.endsWith('remade'))!.detail).toContain('2 mail inboxes');
        expect(host.view().find((i) => i.id.endsWith('remade'))!.detail).not.toContain('proof-of-done');
        await host.noteProofKeyMade();
        const remade = host.view().find((i) => i.id.endsWith('remade'))!;
        expect(remade.detail).toContain('2 mail inboxes');
        expect(remade.detail).toContain('a new key that signs proof-of-done notes');
        // The keychain makes them again afterwards; the note stands, and it is in the record for the next start.
        await chain.set('mail/inbox/in1', SECRET); await chain.set('pod/host-key', SECRET);
        await host.refresh();
        expect(host.view().some((i) => i.id.endsWith('remade'))).toBe(true);
        expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ attach: 'machine-files-gone', remade: { mailInboxes: 2, proofKey: true } });
    });

    it('CONTROL: on the same machine nothing is noted as made again, whatever the keychain holds', async () => {
        const { host } = await open('same', fakeKeychain());
        await host.wire(sourcesOf({ tynn: () => ({ onRecord: false, signedIn: false }), githubLogin: () => null, agentKeyIds: async () => [], workstation: async () => ({ id: null, secret: 'workstation/x' }), deviceUrls: () => [] }));
        expect(host.view()).toEqual([]);
        // A first signing key on an ordinary start is not something made AGAIN.
        await host.noteProofKeyMade();
        expect(host.view()).toEqual([]);
    });

    it('A STANDING ITEM GOES BY ITSELF when the thing is back, and listeners are told; missing again, it is said again', async () => {
        const chain = fakeKeychain({ 'github/access': SECRET, 'tynn/agent/01AAAAAAAAAAAAAAAAAAAAAAAA': SECRET, 'tynn/agent/01BBBBBBBBBBBBBBBBBBBBBBBB': SECRET, 'workstation/https://tynn.ai': SECRET, 'device/wss://desk.tail/ws': SECRET });
        const { host } = await open('same', chain);
        let told = 0;
        host.onChange(() => { told += 1; });
        await host.wire(sourcesOf());
        expect(keys(host.view())).toEqual(['tynn']);
        expect(told).toBe(1);
        await host.answer('genie:attach:tynn', 'dismiss');
        expect(host.view()).toEqual([]);
        // The person signed in: it is held. Then the keychain lost it again: dismissed THEN is not dismissed now.
        await chain.set('tynn/pairing', SECRET); await host.refresh();
        expect(host.view()).toEqual([]);
        chain.held.delete('tynn/pairing'); await host.refresh();
        expect(keys(host.view())).toEqual(['tynn']);
        await chain.set('tynn/pairing', SECRET); await host.refresh();
        expect(host.view()).toEqual([]);
    });

    it('DISMISS IS KEPT across a restart, and what was said once for the attach is still said on the next (ordinary) start', async () => {
        const chain = fakeKeychain();
        const first = await open('another-machine', chain);
        await first.host.wire(sourcesOf());
        expect(keys(first.host.view())).toEqual(['tynn', 'github', 'agent-keys', 'workstation', 'devices', 'remade', 'machine']);
        await first.host.answer('genie:attach:remade', 'dismiss');
        await first.host.answer('genie:attach:devices', 'dismiss');
        const next = await open('same', chain, first.file);
        await next.host.wire(sourcesOf());
        expect(keys(next.host.view())).toEqual(['tynn', 'github', 'agent-keys', 'workstation', 'machine']);
        expect(next.host.view().find((i) => i.id.endsWith('machine'))!.detail).toContain('moved here from another machine');
    });

    it('AN ACTION is the item’s own, runs its port, and a refusal is thrown in words with the item still there', async () => {
        const chain = fakeKeychain();
        const { host } = await open('same', chain);
        const signedOut = sourcesOf();
        await host.wire(signedOut);
        await host.answer('genie:attach:tynn', 'tynn-sign-in');
        await host.answer('genie:attach:github', 'github-sign-in');
        expect(signedOut.calls).toEqual(['tynnSignIn', 'githubSignIn']);
        // Another item's action, an option nobody offered, an item that is not there.
        await expect(host.answer('genie:attach:tynn', 'workstation-register')).rejects.toThrow(/no such action/);
        await expect(host.answer('genie:attach:devices', 'tynn-sign-in')).rejects.toThrow(/no such action/);
        await expect(host.answer('genie:attach:nope', 'dismiss')).rejects.toThrow(/no longer waiting/);
        // Signed out: the two that need Tynn say so and ask Tynn nothing.
        await expect(host.answer('genie:attach:agent-keys', 'agent-keys')).rejects.toThrow('Sign in to Tynn first: Settings → Integrations.');
        await expect(host.answer('genie:attach:workstation', 'workstation-register')).rejects.toThrow('Sign in to Tynn first: Settings → Integrations.');
        expect(signedOut.calls).toEqual(['tynnSignIn', 'githubSignIn']);
        expect(keys(host.view())).toContain('workstation');
    });

    it('REGISTERED AGAIN says which of the two happened, as its own item until it is put away; a failure says why and changes nothing', async () => {
        const chain = fakeKeychain({ 'tynn/pairing': SECRET });
        for (const [outcome, words] of [['new', 'Tynn does not recognise this machine, so it is registered as a new workstation'], ['same', 'permission to drive your other machines is removed until you approve it again in Tynn']] as const) {
            const { host, file } = await open('same', chain);
            const sources = sourcesOf({ tynn: () => ({ onRecord: true, signedIn: true }) });
            sources.act.workstationRegister = async () => { sources.calls.push('workstationRegister'); await chain.set('workstation/https://tynn.ai', SECRET); return { ok: true, outcome, workstationId: 'ws_9' }; };
            await host.wire(sources);
            await host.answer('genie:attach:workstation', 'workstation-register');
            expect(sources.calls).toEqual(['workstationRegister']);
            expect(keys(host.view())).not.toContain('workstation');
            const said = host.view().find((i) => i.id === 'genie:attach:workstation-registered')!;
            expect(said.detail).toContain(words);
            expect(said.detail).toContain('https://tynn.ai/account/workstations');
            expect(said).toMatchObject({ action: null, standing: false });
            // Kept for the next start, and gone for good once dismissed.
            const again = await open('same', chain, file);
            await again.host.wire(sources);
            expect(keys(again.host.view())).toContain('workstation-registered');
            await again.host.answer('genie:attach:workstation-registered', 'dismiss');
            expect(keys(again.host.view())).not.toContain('workstation-registered');
            chain.held.delete('workstation/https://tynn.ai');
        }
        const { host } = await open('same', chain);
        await host.wire(sourcesOf({ tynn: () => ({ onRecord: true, signedIn: true }), act: { ...sourcesOf().act, workstationRegister: async () => ({ ok: false, reason: 'Tynn refused to enroll this machine (500)' }) } }));
        await expect(host.answer('genie:attach:workstation', 'workstation-register')).rejects.toThrow('Tynn refused to enroll this machine (500)');
        expect(keys(host.view())).toContain('workstation');
        expect(keys(host.view())).not.toContain('workstation-registered');
    });

    it('PRESENCE ONLY: no secret’s value is in an item or in the record, and a keychain that stops answering calls nothing missing', async () => {
        const chain = fakeKeychain({ 'github/access': SECRET, 'mail/inbox/in1': SECRET });
        const { host, file } = await open('machine-files-gone', chain);
        await host.wire(sourcesOf());
        expect(JSON.stringify(host.view())).not.toContain(SECRET);
        expect(JSON.stringify(host.items())).not.toContain(SECRET);
        expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
        // CONTROL: the value is in the keychain the host read.
        expect((await chain.get('github/access'))).toEqual({ kind: 'value', value: SECRET });
        const silent = { probe: async () => ({ ok: false as const, reason: 'locked' }), get: async () => ({ kind: 'unavailable' as const, reason: 'locked' }) };
        const locked = await open('same', silent);
        await locked.host.wire(sourcesOf());
        expect(locked.host.view()).toEqual([]);
    });
});

// --- 4. THIS MACHINE REGISTERED AGAIN -----------------------------------------------------------------------------------------

const HOST = 'https://tynn.ai';
const respond = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** A Tynn that answers as Tynn does (WorkstationController::registerMachine): a proof it cannot check is a 422; with none it picks the record itself. */
function tynnDouble(answers: { picks: 'same' | 'new' | 'signed-out' | 'refuses'; enroll?: number }) {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const request = async (path: string, init: { method: 'GET' | 'POST'; body?: unknown }) => {
        const body = (init.body ?? {}) as Record<string, unknown>;
        calls.push({ path, body });
        if (path === '/api/v1/workstations/self-register') {
            if ('proof' in body) return respond(422, { code: 'proof_rejected', reason: 'invalid_signature' });
            if (answers.picks === 'signed-out') return respond(404, null);
            if (answers.picks === 'refuses') return respond(500, { message: 'down' });
            const id = answers.picks === 'same' ? 'ws_old' : 'ws_new';
            return respond(201, { workstation: { id, name: 'desk', status: 'provisioning' }, enrollment: { workstation_id: id, secret: 'one-time', expires_at: null } });
        }
        if (/^\/api\/v1\/workstations\/ws_(old|new)\/enroll$/.test(path)) return respond(answers.enroll ?? 200, answers.enroll && answers.enroll !== 200 ? { message: 'gone' } : { workstation: { status: 'active' } });
        return respond(404, null);
    };
    return { calls, request };
}

describe('this machine registered again, its key gone', () => {
    const fixture = (seed: Record<string, string> = {}) => {
        const file = join(temp('genie-p7-ws-'), 'workstation.json');
        writeFileSync(file, JSON.stringify({ [HOST]: { workstationId: 'ws_old', legacyDone: 'ws_v1' } }));
        const chain = fakeKeychain(seed);
        return { file, chain, store: workstationKeyStore(file, chain), recorded: () => (JSON.parse(readFileSync(file, 'utf8')) as Record<string, { workstationId: string; legacyDone?: string }>)[HOST]! };
    };
    const ports = (f: ReturnType<typeof fixture>, tynn: ReturnType<typeof tynnDouble>) => ({ host: () => HOST, hostname: () => 'desk', request: tynn.request, store: f.store, machineKey: async () => 'mk-0123' });

    it('TYNN KEEPS THE RECORD (it knows the machine): the same id, a new key in the keychain, and it is said as `same`', async () => {
        const { registerWorkstationAgain } = await identity();
        const f = fixture();
        const tynn = tynnDouble({ picks: 'same' });
        expect(await registerWorkstationAgain(ports(f, tynn))).toEqual({ ok: true, outcome: 'same', workstationId: 'ws_old' });
        expect(tynn.calls.map((c) => c.path)).toEqual(['/api/v1/workstations/self-register', '/api/v1/workstations/ws_old/enroll']);
        // NO PROOF, and the old id is sent nowhere in the registration: only the name and the machine key.
        expect(tynn.calls[0]!.body).toEqual({ name: 'desk', machine_key: 'mk-0123' });
        expect(JSON.stringify(tynn.calls[0]!.body)).not.toContain('ws_old');
        expect(f.chain.held.get(`workstation/${HOST}`)).toMatch(/BEGIN PRIVATE KEY/);
        // What else the row said is kept.
        expect(f.recorded()).toEqual({ workstationId: 'ws_old', legacyDone: 'ws_v1' });
        // And the machine reads as itself again.
        expect((await f.store.read(HOST))?.workstationId).toBe('ws_old');
    });

    it('TYNN DOES NOT KNOW THE MACHINE: a new workstation, said as `new`, and the record names it only now', async () => {
        const { registerWorkstationAgain } = await identity();
        const f = fixture();
        const tynn = tynnDouble({ picks: 'new' });
        expect(await registerWorkstationAgain(ports(f, tynn))).toEqual({ ok: true, outcome: 'new', workstationId: 'ws_new' });
        expect(tynn.calls.map((c) => c.path)).toEqual(['/api/v1/workstations/self-register', '/api/v1/workstations/ws_new/enroll']);
        expect(f.recorded().workstationId).toBe('ws_new');
        expect((await f.store.read(HOST))?.workstationId).toBe('ws_new');
    });

    it('A FAILURE LEAVES THE OLD ID ON RECORD and no key behind: the enroll refused, Tynn down, signed out', async () => {
        const { registerWorkstationAgain } = await identity();
        for (const [tynn, reason] of [
            [tynnDouble({ picks: 'new', enroll: 500 }), /Tynn refused to enroll this machine \(500: gone\)/],
            [tynnDouble({ picks: 'refuses' }), /Tynn refused to register this machine again \(500: down\)/],
            [tynnDouble({ picks: 'signed-out' }), /sign in to Tynn to register this machine/],
        ] as const) {
            const f = fixture();
            const r = await registerWorkstationAgain(ports(f, tynn));
            expect(r.ok).toBe(false);
            expect((r as { reason: string }).reason).toMatch(reason);
            expect(f.recorded()).toEqual({ workstationId: 'ws_old', legacyDone: 'ws_v1' });
            expect(f.chain.held.has(`workstation/${HOST}`)).toBe(false);
        }
        const f = fixture();
        const offline = await registerWorkstationAgain({ ...ports(f, tynnDouble({ picks: 'new' })), request: async () => { throw new Error('offline'); } });
        expect(offline).toEqual({ ok: false, reason: 'Tynn was not reached, so this machine was not registered again: offline' });
        expect(f.recorded().workstationId).toBe('ws_old');
    });

    it('NEVER OVER A KEY THAT IS THERE, or one a keychain that did not answer could not show, or with nothing on record: Tynn is asked nothing', async () => {
        const { registerWorkstationAgain } = await identity();
        const { generateKeyPairSync } = await import('node:crypto');
        const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        const held = fixture({ [`workstation/${HOST}`]: pem });
        const tynn = tynnDouble({ picks: 'new' });
        expect(await registerWorkstationAgain(ports(held, tynn))).toEqual({ ok: false, reason: 'This machine still holds the key of workstation ws_old. Nothing was changed.' });

        const f = fixture();
        const silent = { probe: async () => ({ ok: false as const, reason: 'locked' }), get: async () => ({ kind: 'unavailable' as const, reason: 'locked' }), set: async () => ({ ok: false as const, reason: 'locked' }) };
        const locked = await registerWorkstationAgain({ ...ports(f, tynn), store: workstationKeyStore(f.file, silent) });
        expect(locked.ok).toBe(false);
        expect((locked as { reason: string }).reason).toMatch(/Nothing was sent to Tynn/);

        const none = fixture();
        writeFileSync(none.file, '{}');
        expect((await registerWorkstationAgain(ports(none, tynn))).ok).toBe(false);
        expect(tynn.calls).toEqual([]);
    });

    it('SOURCE PIN: the function builds no proof (CONTROL: the ordinary registration beside it does)', () => {
        // The working tree's line ends are the machine's (CRLF on Windows): read as LF.
        const src = readFileSync('src/main/workstation-identity.ts', 'utf8').split(String.fromCharCode(13)).join('');
        const start = src.indexOf('export async function registerWorkstationAgain');
        expect(start).toBeGreaterThan(0);
        const body = src.slice(start, src.indexOf('\n}\n', start));
        expect(body.length).toBeGreaterThan(500);
        expect(body).not.toMatch(/\bproof\b\s*:|buildReattachProof|legacy/);
        const ensure = src.slice(src.indexOf('export async function ensureWorkstation'), start);
        expect(ensure).toMatch(/buildReattachProof/);
    });
});

// --- 5. THE AGENTS' LOST KEYS -------------------------------------------------------------------------------------------------

describe('the agents’ Tynn keys the keychain lost', () => {
    const A = '01AAAAAAAAAAAAAAAAAAAAAAAA';
    const B = '01BBBBBBBBBBBBBBBBBBBBBBBB';
    const vault = () => {
        const file = join(temp('genie-p7-keys-'), 'agent-credentials', 'agents.json');
        mkdirSync(dirname(file), { recursive: true });
        const records = {
            k1: { userId: 'u1', projectId: 'p1', genieId: 'g1', remoteAgentId: 'r1', state: 'ready', publicId: A },
            k2: { userId: 'u1', projectId: 'p1', genieId: 'g2', remoteAgentId: 'r2', state: 'ready', publicId: B },
            k3: { userId: 'u1', projectId: 'p1', genieId: 'g3', remoteAgentId: 'r3', state: 'pending' },
        };
        writeFileSync(file, JSON.stringify({ version: 1, records }), { mode: 0o600 });
        return { file, records, now: () => (JSON.parse(readFileSync(file, 'utf8')) as { records: Record<string, unknown> }).records };
    };

    it('the ids on record are the READY keys’; forgetting takes off record only those the keychain says are MISSING', async () => {
        const { tynnAgentIdentities } = await agentIdentities();
        const v = vault();
        const chain = fakeKeychain({ [`tynn/agent/${B}`]: SECRET });
        const identities = tynnAgentIdentities({ file: v.file, secrets: chain });
        expect((await identities.lostKeys.ids()).sort()).toEqual([A, B]);
        expect(await identities.lostKeys.forget()).toBe(1);
        // The held key's record and the unconfirmed request are untouched: only the lost key's agent mints again.
        expect(v.now()).toEqual({ k2: v.records.k2, k3: v.records.k3 });
        expect(await identities.lostKeys.ids()).toEqual([B]);
        expect(await identities.lostKeys.forget()).toBe(0);
        expect(chain.held.get(`tynn/agent/${B}`)).toBe(SECRET);
    }, 120_000);

    it('A KEYCHAIN THAT DOES NOT ANSWER, or cannot read one entry, loses nothing: no record is taken off', async () => {
        const { tynnAgentIdentities } = await agentIdentities();
        const v = vault();
        const silent = { probe: async () => ({ ok: false as const, reason: 'locked' }), get: async () => ({ kind: 'missing' as const }), set: async () => ({ ok: false as const, reason: 'locked' }) };
        expect(await tynnAgentIdentities({ file: v.file, secrets: silent }).lostKeys.forget()).toBe(0);
        expect(v.now()).toEqual(v.records);
        const unreadable = { probe: async () => ({ ok: true as const }), get: async () => ({ kind: 'unavailable' as const, reason: 'busy' }), set: async () => ({ ok: true as const }) };
        expect(await tynnAgentIdentities({ file: v.file, secrets: unreadable }).lostKeys.forget()).toBe(0);
        expect(v.now()).toEqual(v.records);
    }, 120_000);
});
