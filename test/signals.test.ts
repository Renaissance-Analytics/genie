import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE DECK'S SIGNAL STRIP IS MEASURED (§4.5) — until now every signal was a constant `false`/`0`.
 * `services.signals()` reads the stores: mail agents have not collected and flows running; GitHub blocking features
 * (the GitHub account's measurement) and the OS agent working are handed in by main. The registry takes a signals provider
 * so the estate snapshot carries the live values; without one it stays honest zeros.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};

let dir: string;
let services: ComposedServices;
let roster: AgentRecord[] = [];
/** An agent on the roster — what the registry hands the composed services. */
const onRoster = (id: string, name: string, workspaceId: string): void => {
    roster.push({ id, workspaceId, provider: 'claude', name, instructions: null, threadId: null, createdAt: '2026-10-12T00:00:00.000Z', lastUsedAt: null } as never);
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-signals-'));
    roster = [];
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('services.signals()', () => {
    it('GitHub blocking is what the GitHub account MEASURED (passed in by main), not a ticked box; mail an agent has not collected counts; the OS agent is not working when nothing probes it; no flows run', async () => {
        // The owner (2026-10-20): the two hand-ticked steps were "some dumb list". Whether GitHub blocks features is now
        // the account's own reading of GitHub (core/github.ts githubSignal), handed in like osAgentWorking.
        expect(services.signals({ osAgentWorking: false, githubBlocked: false })).toEqual({ flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false });
        expect(services.signals({ osAgentWorking: false, githubBlocked: true }).githubBlocked).toBe(true);

        onRoster('agent_a', 'atlas', 'tynn');
        await services.inbox.send({ from: HUMAN, to: 'agent_a' as never, text: 'ping' });
        await services.inbox.send({ from: HUMAN, to: 'agent_a' as never, text: 'pong' });
        expect(services.signals({ osAgentWorking: false, githubBlocked: false }).uncollectedMail).toBe(2);
        await services.inbox.receive({ participant: 'agent_a' as never, limit: 1 });
        expect(services.signals({ osAgentWorking: true, githubBlocked: false })).toMatchObject({ uncollectedMail: 1, osAgentWorking: true });
    });
});

describe('the registry’s signals provider', () => {
    it('without a provider the snapshot carries honest zeros; with one, its values', async () => {
        const d = await mkdtemp(join(tmpdir(), 'genie2-signals-registry-'));
        const registry = new Registry(new Store(d));
        await registry.load({ name: 'alphar', healthy: true });
        expect(registry.snapshot().signals).toEqual({ flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false });
        registry.setSignals(() => ({ flowsRunning: 2, uncollectedMail: 3, githubBlocked: true, osAgentWorking: true }));
        expect(registry.snapshot().signals).toEqual({ flowsRunning: 2, uncollectedMail: 3, githubBlocked: true, osAgentWorking: true });
        await rm(d, { recursive: true, force: true });
    });
});
