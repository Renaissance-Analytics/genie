import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentId } from '../src/core/identity.js';
import type { LiveSession } from '../src/core/roster.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * THE REGISTRY — one answer to "what is going on", and it pushes.
 */

let dir: string;
let registry: Registry;

const WORKSTATION = { name: 'alphar', healthy: true };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-registry-'));
    registry = new Registry(new Store(dir));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const live = (over: Partial<LiveSession> = {}): LiveSession => ({
    running: true, turnState: 'working', startedAt: Date.now() - 120_000,
    pendingApproval: null, failure: null, contextUsed: null, contextSize: null,
    lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null,
    ...over,
});

describe('before the store has been read', () => {
    it('claims NOTHING \u2014 no workspaces, and no \u201cagents known\u201d anywhere', () => {
        // The snapshot the renderer would get if it asked too early. It must be the "we have
        // not looked" shape, not the "everything is empty" shape.
        const snapshot = registry.snapshot();

        expect(snapshot.agents).toEqual([]);
        // `null`, not `[]` — see the dedicated describe below for why the difference matters.
        expect(snapshot.workspaces).toBeNull();
        expect(snapshot.deckCount).toBeNull();
        expect(snapshot.workstation).toBeNull();
    });

    it('marks a loaded workspace as KNOWN, and that is the difference', async () => {
        await registry.load(WORKSTATION);
        await registry.addWorkspace({ id: 'tynn', path: 'C:/_Projects/tynn.ai' });

        expect(registry.snapshot().workspaces).toEqual([
            { id: 'tynn', path: 'C:/_Projects/tynn.ai', agentsKnown: true },
        ]);
        // POSITIVE CONTROL: a fresh registry over the SAME store reports it unknown until it
        // loads, so `agentsKnown` is a reading rather than a constant `true`.
        const cold = new Registry(new Store(dir));
        expect(cold.snapshot().workspaces).toBeNull();
        await cold.load(WORKSTATION);
        expect(cold.snapshot().workspaces?.[0]?.agentsKnown).toBe(true);
    });
});

describe('registering an agent', () => {
    it('consumes nothing \u2014 no session, and the running count stays put', async () => {
        /**
         * §6.2 splits registering from starting deliberately: an identity should be creatable
         * and persistable with nothing running, so a workspace can be set up before anybody
         * spends a provider turn on it.
         */
        await registry.load(WORKSTATION);
        await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });

        expect(registry.runningCount).toBe(0);
        expect(registry.snapshot().agents).toHaveLength(1);
        expect(registry.snapshot().agents[0]).toMatchObject({ name: 'atlas', state: 'idle' });
    });

    it('survives a restart, by the id the UI looks it up with', async () => {
        await registry.load(WORKSTATION);
        const record = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });

        const reopened = new Registry(new Store(dir));
        await reopened.load(WORKSTATION);

        // BYTE-IDENTICAL. An id that round-trips as a different string is §0.4: everything
        // "works" and the UI shows an empty session forever.
        expect(reopened.find(record.id)?.id).toBe(record.id);
        expect(reopened.snapshot().agents[0]?.id).toBe(record.id);
    });
});

describe('counting what is running', () => {
    it('counts SESSIONS, never processes', async () => {
        /**
         * §2.5. "3 of 5 running" is a property of this map. The previous build counted ptys,
         * which is why removing ptys from agents broke fifty-two tests — fifty-two places had
         * agreed that an agent's existence was a terminal's existence.
         */
        await registry.load(WORKSTATION);
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        const b = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'kai' });
        await registry.register({ workspaceId: 'tynn', provider: 'codex', name: 'wren' });

        const running = new Map<AgentId, LiveSession>([[a.id, live()], [b.id, live()]]);
        registry.setProbe((id) => running.get(id) ?? null);

        expect(registry.runningCount).toBe(2);
        expect(registry.snapshot().agents.filter((r) => r.state === 'working')).toHaveLength(2);
        // The third is idle, not absent: stopping an agent is not deleting it.
        expect(registry.snapshot().agents).toHaveLength(3);
    });

    it('frees the slot when a session ends', async () => {
        await registry.load(WORKSTATION);
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });

        // Probed BY ID. A blanket `() => live()` also answers for the OS agent, which really
        // is a live session and really does count towards capacity — so the earlier version of
        // this fixture was asserting 1 while describing 2.
        let session: LiveSession | null = live();
        registry.setProbe((id) => (id === a.id ? session : null));
        expect(registry.runningCount).toBe(1);

        session = null;
        expect(registry.runningCount).toBe(0);
        expect(registry.snapshot().agents[0]).toMatchObject({ id: a.id, state: 'idle' });
    });
});

describe('push, never poll', () => {
    it('notifies on registration and on a touch, and stops after unsubscribe', async () => {
        await registry.load(WORKSTATION);

        const seen = vi.fn();
        const off = registry.subscribe(seen);

        await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        expect(seen).toHaveBeenCalledTimes(1);

        registry.touch();
        expect(seen).toHaveBeenCalledTimes(2);

        // The snapshot it hands over is the real one, not a stale closure.
        expect(seen.mock.calls[1]?.[0].agents).toHaveLength(1);

        off();
        registry.touch();
        expect(seen).toHaveBeenCalledTimes(2);
    });

    it('reports a dropped record as a FAULT rather than quietly having fewer agents', async () => {
        // A record that failed to parse is a missing agent, and a missing agent with no message
        // is indistinguishable from one the user forgot they made.
        const store = new Store(dir);
        await store.writeAgents([]);
        const { writeFile, mkdir } = await import('node:fs/promises');
        await mkdir(join(dir, 'runtime'), { recursive: true });
        await writeFile(store.agentsFile, JSON.stringify([{ id: 'nope' }]), 'utf8');

        const r = new Registry(store);
        await r.load(WORKSTATION);

        expect(r.snapshot().agents).toEqual([]);
        expect(r.faults).toHaveLength(1);
        expect(r.faults[0]).toContain('agents.json[0]');

        // POSITIVE CONTROL: a clean load reports no faults, so a non-empty list means something.
        const clean = new Registry(new Store(await mkdtemp(join(tmpdir(), 'genie2-clean-'))));
        await clean.load(WORKSTATION);
        expect(clean.faults).toEqual([]);
    });
});

describe('the OS agent', () => {
    it('is seeded on first load, because the rail says it is always present', async () => {
        /**
         * The rail carries a `genie` row unconditionally — *"the OS agent — always present"*.
         * A row that navigates to an agent which does not exist is a row that lands on a
         * not-found, which is the same class of failure as a disabled control: the product
         * offering something it cannot deliver.
         *
         * So the registry seeds it rather than the rail hiding it. It is a real record with a
         * real id, and it persists like any other.
         */
        await registry.load(WORKSTATION);

        const os = registry.osAgent();
        expect(os).toMatchObject({ provider: 'claude', name: 'genie' });
        // Findable by the id the UI looks it up with, which is what the rail's row needs.
        expect(registry.find(os!.id)).toBe(os);
    });

    it('is seeded ONCE, not again on every load', async () => {
        // The bug this guards is a workspace filling with `genie` agents across restarts.
        await registry.load(WORKSTATION);
        const first = registry.osAgent();

        const reopened = new Registry(new Store(dir));
        await reopened.load(WORKSTATION);
        await reopened.load(WORKSTATION);

        // The SAME record, by the id the UI looks it up with — not a second one.
        expect(reopened.osAgent()?.id).toBe(first?.id);
    });

    it('is NOT in the Dashboard’s census at all', async () => {
        /**
         * It is *"the one agent that is not in a workspace"*, so it appears in no workspace
         * group — and a header chip counting it would read `1 working` with no working row
         * anywhere to account for it. **A number a reader cannot trace to a row is worse than
         * no number.**
         *
         * It is reached from the rail, by its own route.
         */
        await registry.load(WORKSTATION);
        await registry.addWorkspace({ id: 'tynn', path: 'C:/_Projects/tynn.ai' });
        await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });

        expect(registry.snapshot().agents.map((a) => a.name)).toEqual(['atlas']);

        // POSITIVE CONTROL: it exists and is findable; it is the CENSUS it stays out of.
        expect(registry.osAgent()).not.toBeNull();
    });
});

describe('workspaces before the store has been read', () => {
    it('is NULL, not an empty array', () => {
        /**
         * The two are different claims and they get different surfaces: `[]` means Genie looked
         * and this machine has no workspaces — a first run, which deserves an invitation —
         * while `null` means nobody has looked, which deserves a skeleton.
         *
         * The distinction was missing for exactly one commit, and the Dashboard's new first-run
         * state announced "Nothing is being worked on yet" before the bridge had answered. An
         * older test caught it, which is the whole argument for keeping the empty-snapshot
         * assertions around.
         */
        const cold = new Registry(new Store(dir));
        expect(cold.snapshot().workspaces).toBeNull();
    });

    it('is an ARRAY once loaded, even when there are none', async () => {
        // POSITIVE CONTROL: `null` is a reading, not a constant.
        const loaded = new Registry(new Store(dir));
        await loaded.load(WORKSTATION);
        expect(loaded.snapshot().workspaces).toEqual([]);
    });
});
