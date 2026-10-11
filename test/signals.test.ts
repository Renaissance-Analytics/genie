import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HUMAN } from '../src/core/inbox.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE DECK'S SIGNAL STRIP IS MEASURED (§4.5) — until now every signal was a constant `false`/`0`.
 * `services.signals()` reads the stores: mail agents have not collected, GitHub blocking features
 * (not yet authorized), the OS agent working, flows running. The registry takes a signals provider
 * so the estate snapshot carries the live values; without one it stays honest zeros.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};

let dir: string;
let services: ComposedServices;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-signals-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('services.signals()', () => {
    it('GitHub blocks until authorized AND installed; mail an agent has not collected counts; the OS agent is not working when nothing probes it; no flows run', async () => {
        expect(services.signals({ osAgentWorking: false })).toEqual({ flowsRunning: 0, uncollectedMail: 0, githubBlocked: true, osAgentWorking: false });
        // Two distinct steps: authorized alone still blocks (install is missing); installed unblocks.
        await services.settings.set('github_authorized', true);
        expect(services.signals({ osAgentWorking: false }).githubBlocked).toBe(true);
        await services.settings.set('github_installed', true);
        expect(services.signals({ osAgentWorking: false }).githubBlocked).toBe(false);

        services.registerAgentName('agent_a' as never, { name: 'atlas', workspaceId: 'tynn' });
        services.registerAgentAddress('claude:atlas', 'agent_a' as never);
        await services.inbox.send({ from: HUMAN, to: 'agent_a' as never, text: 'ping' });
        await services.inbox.send({ from: HUMAN, to: 'agent_a' as never, text: 'pong' });
        expect(services.signals({ osAgentWorking: false }).uncollectedMail).toBe(2);
        await services.inbox.receive({ participant: 'agent_a' as never, limit: 1 });
        expect(services.signals({ osAgentWorking: true })).toMatchObject({ uncollectedMail: 1, osAgentWorking: true });
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
