import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE HUMAN REACHES AGENTS ON THE LIVE ROSTER (§6.4: the human is a first-class participant). The composed services
 * resolved the human's addresses, named agents, counted their uncollected mail and timed their reminders from two
 * registries nothing in the app ever filled — so the Inbox surface listed no peers, every send from it said
 * `nobody at …`, the file panel's pause notice never arrived, and the Deck's uncollected-mail signal never showed.
 * The agents' own inbox tool resolves against the roster; the human's path now reads the same roster.
 */
const pty: PtyPort = {
    spawn: () => { throw new Error('no pty in this test'); },
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
} as never;

const record = (id: string, name: string, workspaceId = 'tynn'): AgentRecord => ({
    id: id as never, workspaceId, provider: 'claude', name, instructions: null, threadId: null,
    createdAt: '2026-10-12T00:00:00.000Z', lastUsedAt: null, mode: 'manual', accessScope: 'workspace',
} as never);

let dir: string;
let services: ComposedServices;
let roster: AgentRecord[];

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-roster-'));
    roster = [record('agent_a', 'atlas')];
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster });
});
afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('the human inbox, from the roster', () => {
    it('sends to an agent by its full and its short address, with nothing registered by hand', async () => {
        await handleFeatureAction(services, { kind: 'inbox.send', to: 'tynn:claude:atlas', text: 'one' });
        await handleFeatureAction(services, { kind: 'inbox.send', to: 'claude:atlas', text: 'two' });
        expect(services.inbox.unread('agent_a' as never).map((m) => m.text)).toEqual(['one', 'two']);
    });

    it('reaches an agent added after start, and lists every roster agent as a peer', async () => {
        roster.push(record('agent_b', 'wren', 'fancy'));
        await handleFeatureAction(services, { kind: 'inbox.send', to: 'fancy:claude:wren', text: 'hi' });
        expect(services.inbox.unread('agent_b' as never)).toHaveLength(1);
        const snap = await featureSnapshot(services, { toolStatuses: null, knowledgeQuery: '' });
        expect(snap.inbox!.peers.map((p) => [p.address, p.name])).toEqual([['tynn:claude:atlas', 'atlas'], ['fancy:claude:wren', 'wren']]);
    });

    it('two agents with one short name: the short form is refused naming both full forms', async () => {
        roster.push(record('agent_c', 'atlas', 'moic'));
        await expect(handleFeatureAction(services, { kind: 'inbox.send', to: 'claude:atlas', text: 'x' })).rejects.toThrow(/tynn:claude:atlas.*moic:claude:atlas|moic:claude:atlas.*tynn:claude:atlas/);
    });

    it('counts a roster agent\'s uncollected mail in the Deck signal (positive control: 0 before the send)', async () => {
        expect(services.signals({ osAgentWorking: false, githubBlocked: false }).uncollectedMail).toBe(0);
        await handleFeatureAction(services, { kind: 'inbox.send', to: 'claude:atlas', text: 'read me' });
        expect(services.signals({ osAgentWorking: false, githubBlocked: false }).uncollectedMail).toBe(1);
    });
});
