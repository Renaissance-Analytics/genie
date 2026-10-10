import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { Store } from '../src/main/store.js';

/**
 * WHAT GENIE REMEMBERS BETWEEN RUNS.
 *
 * The file this store writes holds **every agent identity Genie has**. A persona survives in
 * the repo; the record that points an agent at its thread does not exist anywhere else. So the
 * tests below are mostly about the ways a save can destroy one.
 */

let dir: string;
let store: Store;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-store-'));
    store = new Store(dir);
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const record = (name: string) =>
    agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name });

describe('a first run', () => {
    it('reads empty rather than failing', async () => {
        expect(await store.readAgents()).toEqual([]);
        expect(await store.readWorkspaces()).toEqual([]);
    });
});

describe('a round trip', () => {
    it('returns every field of every record, with the id still an agent id', async () => {
        const written = [record('atlas'), record('kai')];
        await store.writeAgents(written);

        const read = await store.readAgents();
        expect(read).toEqual(written);
        // The id survives as the branded value the session store is keyed by. If this came back
        // as a bare string that happened to match, a later `asAgentId` would be doing the work
        // and a malformed id would reach the store.
        expect(read[0]?.id).toBe(written[0]?.id);
    });

    it('writes nothing outside the runtime directory', async () => {
        await store.writeAgents([record('atlas')]);
        expect(store.agentsFile.replace(/\\/g, '/')).toContain('/runtime/');
    });
});

describe('writes are atomic', () => {
    it('leaves no .tmp file behind on success', async () => {
        await store.writeAgents([record('atlas')]);
        await expect(readFile(`${store.agentsFile}.tmp`, 'utf8')).rejects.toThrow();
    });

    it('replaces the old file rather than appending to it', async () => {
        await store.writeAgents([record('atlas'), record('kai')]);
        await store.writeAgents([record('wren')]);

        const read = await store.readAgents();
        expect(read).toHaveLength(1);
        expect(read[0]?.name).toBe('wren');
    });
});

describe('a file that cannot be trusted', () => {
    it('THROWS on malformed JSON instead of reading as empty', async () => {
        /**
         * The most destructive bug this file could have. Reading a truncated file as `[]` looks
         * like a graceful recovery and is a two-step deletion: Genie boots with no agents, the
         * first save writes `[]` over the corrupt file, and the identities are gone for real.
         *
         * A truncated file is exactly what an interrupted write produces, which is why the
         * writes above are atomic — and why this must still fail loudly if one ever is.
         */
        await mkdir(join(dir, 'runtime'), { recursive: true });
        await writeFile(store.agentsFile, '[{"id":"ag_', 'utf8');

        await expect(store.readAgents()).rejects.toThrow(/not valid JSON and was NOT overwritten/);
    });

    it('DROPS a record missing fields, naming it, rather than repairing it', async () => {
        /**
         * A repaired record is worse than a dropped one. Defaulting a missing `threadId` to
         * `null` produces an agent that starts a brand new conversation on next run — the user
         * sees an agent that forgot everything, which reads as a model fault rather than as a
         * storage fault, and nobody looks here.
         */
        const good = record('atlas');
        await mkdir(join(dir, 'runtime'), { recursive: true });
        await writeFile(
            store.agentsFile,
            JSON.stringify([good, { id: String(mintAgentId()), name: 'half-a-record' }]),
            'utf8',
        );

        const read = await store.readAgents();
        expect(read.map((r) => r.name)).toEqual(['atlas']);
        expect(store.dropped).toHaveLength(1);
        expect(store.dropped[0]).toContain('agents.json[1]');
        expect(store.dropped[0]).toContain('missing');
    });

    it('drops a record whose id is not an agent id', async () => {
        await mkdir(join(dir, 'runtime'), { recursive: true });
        const broken = { ...record('atlas'), id: 'not-an-agent-id' };
        await writeFile(store.agentsFile, JSON.stringify([broken]), 'utf8');

        expect(await store.readAgents()).toEqual([]);
        expect(store.dropped[0]).toContain('is not an agent id');
    });

    it('reports no drops on a clean read — the list is a reading, not a constant', async () => {
        // POSITIVE CONTROL for the two tests above: `dropped` is cleared and stays empty when
        // nothing is wrong, so a non-empty `dropped` means something.
        await store.writeAgents([record('atlas'), record('kai')]);
        expect(await store.readAgents()).toHaveLength(2);
        expect(store.dropped).toEqual([]);
    });
});
