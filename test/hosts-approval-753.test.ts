import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, describe, expect, it } from 'vitest';
import { hostsFileBlock } from '../src/core/gen-router.js';
import { SITE_REACH_DECK_PREFIX } from '../src/core/site-reach.js';
import { mintAgentId } from '../src/core/identity.js';
import type { DeckItem } from '../src/core/deck.js';
import { answerDeck, type DeckAnswerPorts } from '../src/main/deck-answer.js';
import { Elevator, hostsWriteStep, realHostsIo, type ElevationOutcome, type PrivilegedStep } from '../src/main/elevate.js';
import { HOSTS_STEP_ID, HostsSync, type HostsIo, type HostsSyncResult } from '../src/main/hosts-file.js';
import type { HostingServices } from '../src/main/hosting-actions.js';
import { hostingTools, SITES_TOOL } from '../src/main/mcp-tools-hosting.js';
import type { Caller, Registration } from '../src/main/mcp-tools.js';
import { hostingRig, tick, type HostingRig } from './helpers/hosting-rig.js';

/**
 * TYNN #753 (and #744, its duplicate): AN AGENT'S `sites add` RAISED A WINDOWS UAC PROMPT WITH NOTHING IN GENIE SAYING WHY.
 *
 * The chain: `sites add` → sites.onChange → HostsSync.changed → a 250 ms debounce → flush() → the plain write of the hosts
 * file refused (EPERM) → hosts.next staged in the user's folder → the Elevator → genie-host asks the connected window →
 * the window runs `powershell Copy-Item hosts.next → hosts` elevated, at once. No approval, even in an untrusted
 * workspace, and the staged file sat user-writable between the prompt and the copy.
 *
 * The contract now:
 * - A site change NEVER elevates on its own. It records that a hosts write is due and Genie asks in the Deck ("Genie needs
 *   administrator permission to add <name>.gen to your hosts file so your normal browser can open it"): Approve, Not now,
 *   Copy the block. The OS prompt runs only from the person's Approve (or Try again, or a Trust), the way Trust does.
 * - The elevated copy checks the SHA-256 of what Genie composed and copies those bytes only: a hosts.next rewritten after
 *   it was staged is refused and the hosts file is left alone.
 * - The agents' `sites` and `services` tools act only in a trusted workspace; the approval for `sites update`/`remove`
 *   says an administrator step may follow.
 *
 * Inert stubs throughout: the window's elevation is a recorder (helpers/hosting-rig.ts), nothing privileged runs, and the
 * one real copy (the step itself, run unelevated) is between two temp files.
 */

let rig: HostingRig | null = null;
const dirs: string[] = [];
afterEach(async () => {
    await rig?.close();
    rig = null;
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** The agents' `sites` / `services` tools on the rig's own hosting, as genie-host wires them. */
function agentTools(r: HostingRig, trusted: (workspaceId: string) => boolean = () => true): { tools: Registration[]; caller: Caller; approvals: string[] } {
    const caller: Caller = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'ws', workspacePath: r.ws };
    const approvals: string[] = [];
    const s = r.stack;
    const services: HostingServices = {
        sites: s.sites, envelopeSites: s.envelopeSites, engines: s.engines, supervisor: r.supervisor,
        routes: () => s.routes(), engineStatuses: () => s.engineStatuses(), startEngine: (id) => s.startEngine(id), stopEngine: (id) => s.stopEngine(id),
        removeEngine: (id, o) => s.removeEngine(id, o), engineDependents: (id) => s.engineDependents(id), updateEngine: (id, o) => s.updateEngine(id, o),
    } as HostingServices;
    const tools = hostingTools({
        resolveCaller: (id) => (id === 't-atlas' ? caller : null),
        approve: async (_c, action, detail) => { approvals.push(`${action}: ${detail}`); return 'allowed'; },
        services,
        trusted,
    } as Parameters<typeof hostingTools>[0]);
    return { tools, caller, approvals };
}

async function call(tools: Registration[], name: 'sites' | 'services', args: JsonObject): Promise<{ isError: boolean; json: Record<string, unknown> }> {
    const r = tools.find((t) => t.definition.name === name)!;
    const out = await r.handler({ terminalId: 't-atlas', ...args }, { server: 'genie', tool: name, headers: {} } as never);
    return { isError: out.isError === true, json: JSON.parse(String(out.text)) as Record<string, unknown> };
}

const settled = async (r: HostingRig) => { await tick(); await r.stack.frontDoorSettled(); await tick(); };
// Since Tynn #743 the ask for a NEW name is the one "Open <name> in your browser" row (core/site-reach.ts); with the
// certificate already trusted (as these rigs say) it carries the hosts write alone.
const hostsAsk = (r: HostingRig): DeckItem | undefined => r.stack.trustDeckItems().find((i) => i.id.startsWith(SITE_REACH_DECK_PREFIX));
const trustedRig = () => hostingRig({ hosting: { trustStore: { has: async () => true } } });

describe('an agent’s site never raises the OS prompt: Genie asks in the Deck, and the person’s Approve is the prompt', () => {
    it('agent `sites add` with a window connected → ZERO Elevator calls', async () => {
        rig = await hostingRig();
        await rig.window();
        const { tools } = agentTools(rig);
        const r = await call(tools, 'sites', { action: 'add', name: 'shop', repoPath: rig.ws, mode: 'proxy', hostPort: 5175 });
        expect(r.isError).toBe(false);
        await settled(rig);
        expect(rig.stack.configuredHosts()).toContain('shop.gen');
        expect(rig.elevationsAsked).toEqual([]);
    });

    it('…and the person is asked in the Deck, in place: “Open shop.gen in your browser”, why the computer asks, Open in browser / Not now / Copy the block', async () => {
        rig = await trustedRig();
        await rig.window();
        const { tools } = agentTools(rig);
        await call(tools, 'sites', { action: 'add', name: 'shop', repoPath: rig.ws, mode: 'proxy', hostPort: 5175 });
        await settled(rig);
        const item = hostsAsk(rig);
        expect(item?.title).toBe('Open shop.gen in your browser');
        expect(item?.why).toBe('Your computer asks once for administrator permission: Genie adds shop.gen to your hosts file. Until then the site works in Genie’s browser.');
        expect(item?.answer).toEqual({ kind: 'inline', options: [{ id: 'open', label: 'Open in browser', tone: 'ok' }, { id: 'later', label: 'Not now', tone: 'neutral' }, { id: 'copy-detail', label: 'Copy the block', tone: 'neutral' }] });
        expect(item?.detail).toBe(hostsFileBlock(['shop.gen']));
        const hosts = rig.stack.externalFrontDoor.running ? rig.stack.externalFrontDoor.hosts : null;
        expect(hosts).toMatchObject({ changed: false, awaitingApproval: true, manualBlock: hostsFileBlock(['shop.gen']) });
    });

    it('the person’s Open in browser is the ONE elevation, carrying the hosts step; the ask is then gone', async () => {
        rig = await trustedRig();
        const w = await rig.window();
        const { tools } = agentTools(rig);
        await call(tools, 'sites', { action: 'add', name: 'shop', repoPath: rig.ws, mode: 'proxy', hostPort: 5175 });
        await settled(rig);
        const item = hostsAsk(rig);
        expect(item).toBeDefined();
        expect(rig.elevationsAsked).toHaveLength(0);
        const ports = { attention: {} as never, approvals: {} as never, inbox: {} as never, trustCertificate: () => w.replica.trustCertificate(), syncHosts: () => w.replica.syncHosts(), deferHosts: () => w.replica.deferHosts() } as DeckAnswerPorts;
        await answerDeck({ kind: 'deck.answer', item: item!, optionId: 'open' }, ports);
        await settled(rig);
        expect(rig.elevationsAsked.map((b) => b.map((s) => s.id))).toEqual([[HOSTS_STEP_ID]]);
        expect(hostsAsk(rig)).toBeUndefined();
    });

    it('a site created by the person or declared by a workspace raises nothing either: same ask, zero prompts', async () => {
        rig = await hostingRig();
        await rig.window();
        await rig.stack.envelopeSites.create({ name: 'docs', workspaceId: 'ws', repoPath: rig.ws, serve: { mode: 'proxy' }, hostPort: 5176 });
        await settled(rig);
        expect(rig.elevationsAsked).toEqual([]);
        expect(hostsAsk(rig)?.title).toContain('docs.gen');
    });
});

// ---- HostsSync on its own: the automatic path records; only the person's actions elevate. ----

function unitSync(initial = '127.0.0.1 localhost\n') {
    let content = initial;
    const calls: string[] = [];
    const io: HostsIo = {
        read: async () => { calls.push('read'); return content; },
        write: async () => { calls.push('write'); throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); },
        stage: async (next) => { calls.push('stage'); content = next; return { command: 'cp', args: [] }; },
    };
    const batches: string[][] = [];
    const elevator = new Elevator(async (steps: readonly PrivilegedStep[]): Promise<ElevationOutcome> => { batches.push(steps.map((s) => s.id)); return { ok: true }; });
    const timers: Array<() => void> = [];
    let names: string[] = [];
    const results: HostsSyncResult[] = [];
    const sync = new HostsSync({ names: () => names, io, elevator, debounceMs: 250, schedule: (fn) => { timers.push(fn); return () => {}; }, onResult: (r) => results.push(r) });
    const fire = async () => { for (const t of timers.splice(0)) t(); await sync.settled(); };
    return { sync, calls, batches, results, fire, setNames: (n: string[]) => { names = n; } };
}

describe('HostsSync: begin() and changed() never elevate', () => {
    it('the plain write refused: zero prompts, nothing staged, the due write recorded with the block to paste', async () => {
        const t = unitSync();
        t.setNames(['shop.gen']);
        t.sync.begin();
        await t.fire();
        t.setNames(['shop.gen', 'docs.gen']);
        t.sync.changed();
        await t.fire();
        expect(t.batches).toEqual([]);
        expect(t.calls).not.toContain('stage');
        expect(t.sync.result).toMatchObject({ changed: false, elevated: false, awaitingApproval: true, manualBlock: hostsFileBlock(['shop.gen', 'docs.gen']) });
        expect(t.sync.deckItems().map((i) => i.title)).toEqual(['Genie needs administrator permission to add docs.gen and shop.gen to your hosts file so your normal browser can open them']);
    });

    it('Not now puts the ask away until the names change; a new name asks again, still without a prompt', async () => {
        const t = unitSync();
        t.setNames(['shop.gen']);
        t.sync.begin();
        await t.fire();
        t.sync.defer();
        expect(t.sync.deckItems()).toEqual([]);
        t.sync.changed();
        await t.fire();
        expect(t.sync.deckItems()).toEqual([]);
        t.setNames(['shop.gen', 'api.gen']);
        t.sync.changed();
        await t.fire();
        expect(t.sync.deckItems().map((i) => i.title)).toEqual(['Genie needs administrator permission to add api.gen and shop.gen to your hosts file so your normal browser can open them']);
        expect(t.batches).toEqual([]);
    });

    it('CONTROL: flush() — the person’s Approve or Try again — is exactly one prompt, carrying the hosts step', async () => {
        const t = unitSync();
        t.setNames(['shop.gen']);
        expect(await t.sync.flush()).toEqual({ changed: true, elevated: true });
        expect(t.batches).toEqual([[HOSTS_STEP_ID]]);
    });
});

// ---- The swap gap: what the elevated step copies is what Genie composed, byte for byte. ----

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('the elevated copy carries the SHA-256 of what Genie composed (no swap between staging and the prompt)', () => {
    it('the Windows step names the hash and copies only matching bytes — never a bare Copy-Item of whatever is there', () => {
        const step = hostsWriteStep('win32', 'C:\\Users\\Jo\\.genie\\runtime\\hosts.next', 'C:\\Windows\\System32\\drivers\\etc\\hosts', sha256('x'));
        const script = step.args.at(-1)!;
        expect(script).not.toContain('Copy-Item');
        expect(script).toContain(sha256('x').toUpperCase());
        expect(script).toContain("ReadAllBytes('C:\\Users\\Jo\\.genie\\runtime\\hosts.next')");
        expect(script).toContain("WriteAllBytes('C:\\Windows\\System32\\drivers\\etc\\hosts', $b)");
    });

    const realStep = async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hosts-753-'));
        dirs.push(dir);
        const target = join(dir, 'hosts');
        await writeFile(target, '127.0.0.1 localhost\n', 'utf8');
        const io = realHostsIo({ platform: process.platform, tmpDir: dir, hostsPath: target });
        const composed = `127.0.0.1 localhost\n${hostsFileBlock(['shop.gen'])}\n`;
        const step = await io.stage(composed);
        const run = () => spawnSync(step.command, [...step.args], { encoding: 'utf8', env: { ...process.env, ...step.env } });
        return { dir, target, composed, run };
    };

    it.skipIf(process.platform === 'win32')('unix, the real step run unelevated on temp files: a hosts.next rewritten after staging is REFUSED, the target untouched', async () => {
        const s = await realStep();
        await writeFile(join(s.dir, 'hosts.next'), '140.82.0.1 github.com\n', 'utf8');
        const r = s.run();
        expect(r.status).not.toBe(0);
        expect(await readFile(s.target, 'utf8')).toBe('127.0.0.1 localhost\n');
    });

    it.skipIf(process.platform === 'win32')('CONTROL (unix): the staged file untouched → the step lands exactly what Genie composed', async () => {
        const s = await realStep();
        const r = s.run();
        expect(r.status).toBe(0);
        expect(await readFile(s.target, 'utf8')).toBe(s.composed);
    });

    it.runIf(process.platform === 'win32')('Windows, the real step run unelevated on temp files: a rewritten hosts.next is REFUSED, the target untouched', async () => {
        const s = await realStep();
        await writeFile(join(s.dir, 'hosts.next'), '140.82.0.1 github.com\r\n', 'utf8');
        const r = s.run();
        expect(r.status).not.toBe(0);
        expect(await readFile(s.target, 'utf8')).toBe('127.0.0.1 localhost\n');
    });

    it.runIf(process.platform === 'win32')('CONTROL (Windows): the staged file untouched → the step lands exactly what Genie composed', async () => {
        const s = await realStep();
        const r = s.run();
        expect(r.status).toBe(0);
        expect(await readFile(s.target, 'utf8')).toBe(s.composed);
    });
});

// ---- The agents' tools: trusted workspaces only; the approval says what follows. ----

describe('the agents’ `sites` and `services` act only in a trusted workspace', () => {
    it('untrusted: `sites add` and `services list` are refused in words, and no site is made', async () => {
        rig = await hostingRig();
        const { tools } = agentTools(rig, () => false);
        const add = await call(tools, 'sites', { action: 'add', name: 'shop', repoPath: rig.ws, mode: 'proxy', hostPort: 5175 });
        expect(add.isError).toBe(true);
        expect(String(add.json.error)).toMatch(/not trusted/);
        expect((await call(tools, 'services', { action: 'list' })).isError).toBe(true);
        expect(rig.stack.sites.list()).toEqual([]);
    });

    it('CONTROL: trusted, the same `sites add` makes the site', async () => {
        rig = await hostingRig();
        const { tools } = agentTools(rig, () => true);
        const add = await call(tools, 'sites', { action: 'add', name: 'shop', repoPath: rig.ws, mode: 'proxy', hostPort: 5175 });
        expect(add.isError).toBe(false);
        expect(rig.stack.sites.list().map((s) => s.host)).toEqual(['shop.gen']);
    });

    it('the approval for `sites update` (a rename) and `sites remove` says an administrator step may follow', async () => {
        rig = await hostingRig();
        const { tools, approvals } = agentTools(rig);
        await call(tools, 'sites', { action: 'add', name: 'shop', repoPath: rig.ws, mode: 'proxy', hostPort: 5175 });
        await call(tools, 'sites', { action: 'update', site: 'shop', name: 'store' });
        await call(tools, 'sites', { action: 'remove', site: 'store' });
        expect(approvals.map((a) => a.split(':')[0])).toEqual(['sites.update', 'sites.remove']);
        for (const a of approvals) expect(a).toContain('Genie then asks you in the Deck for administrator permission to update the hosts file');
    });

    it('the `sites` tool tells the agent the person is asked, and that Genie never raises the prompt on its own', () => {
        expect(SITES_TOOL.description).toContain('Adding, renaming or removing a site may need the person’s administrator permission for the hosts file: Genie asks them in its Deck and never raises the prompt on its own; the site works in Genie’s browser meanwhile.');
    });
});

// ---- The guard: every elevation sits behind a person's action. ----

async function sources(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...await sources(p));
        else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
}

describe('guard: the Elevator is reached only from a person’s action', () => {
    it('HostsSync’s debounce never calls flush(), and `elevator.run(` is called only by HostsSync.flush and the Trust', async () => {
        const root = join(__dirname, '..');
        const hostsSrc = await readFile(join(root, 'src/main/hosts-file.ts'), 'utf8');
        // The automatic path (begin/changed → #request → the debounce) must not reach flush(), the person's door.
        expect(hostsSrc).not.toMatch(/this\.flush\(\)/);
        const callers: string[] = [];
        for (const f of await sources(join(root, 'src'))) {
            const text = await readFile(f, 'utf8');
            const n = text.match(/elevator\.run\(/g)?.length ?? 0;
            if (n > 0) callers.push(`${relative(root, f).replace(/\\/g, '/')}:${n}`);
        }
        expect(callers.sort()).toEqual(['src/main/hosting-compose.ts:1', 'src/main/hosts-file.ts:1']);
        // In hosts-file.ts the one call is inside flush().
        const flushBody = hostsSrc.slice(hostsSrc.indexOf('    flush(): Promise<HostsSyncResult> {'), hostsSrc.indexOf('    joinElevation('));
        expect(flushBody).toContain('elevator.run(');
    });
});
