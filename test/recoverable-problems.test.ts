import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';

/**
 * THE OWNER SAW IT (2026-10-14): the agent's row read `Broken · NDJSON frame exceeds 1000000 bytes (1036723 bytes;
 * content withheld)` while the agent went on working, and the red cleared on its own a little later. prism-acp had
 * dropped ONE frame it could not read and said so; Genie took every protocol error as the session's death.
 *
 * prism-acp now marks a problem that costs one thing and leaves the session running `{ recoverable: true }`. Such a
 * problem is a WARNING ROW in the agent's stream; the state is untouched. Anything not marked recoverable is a failure,
 * as before (a provider that cannot start must never look idle).
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noTree: ProcessTree = { descendantsOf: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-recoverable-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    };
    const store = openDurableStore(dir);
    const id = mintAgentId();
    const session = new AgentSession({ agentId: id, cwd: dir, store, driverFactory: factory, processTree: noTree });
    session.start();
    return { session, store, id, events: () => events };
}

describe('a RECOVERABLE problem', () => {
    it('is a warning row in the stream; the turn goes on and nothing reads failed', async () => {
        const { session, store, id, events } = open();
        expect(session.turnState).toBe('working');

        events().onProtocolError?.('NDJSON frame exceeds 64000000 bytes (64000001 bytes; content withheld)', { recoverable: true });

        expect(session.turnState).toBe('working');
        expect(session.failure).toBeNull();
        // The thread write is async: wait for it to SETTLE, never for a clock. A 1 s waitFor here failed one suite run in
        // three under the release gate's back-to-back load (beta.29 gate, 2026-10-17) with the row simply not yet written.
        await session.settled();
        const rows = (await openAgentThread(store, id).messages()).map((r) => r.message as { kind: string; level?: string; message?: string });
        // COUNTED: exactly one warning notice, carrying prism-acp's own words.
        expect(rows.filter((r) => r.kind === 'notice' && r.level === 'warning')).toEqual([
            expect.objectContaining({ message: 'NDJSON frame exceeds 64000000 bytes (64000001 bytes; content withheld)' }),
        ]);
    });

    it('a clean exit after one still reads STOPPED, not failed', () => {
        const { session, events } = open();
        events().onProtocolError?.('failed to remove temporary Claude MCP configuration', { recoverable: true });
        events().onExit?.(0, null);
        expect(session.turnState).toBe('stopped');
        expect(session.failure).toBeNull();
    });
});

describe('POSITIVE CONTROL: a problem NOT marked recoverable', () => {
    it('is still a failure with the provider’s words (no detail, and recoverable: false)', () => {
        const a = open();
        a.events().onProtocolError?.('failed to spawn: spawn claude ENOENT');
        expect(a.session.turnState).toBe('failed');
        expect(a.session.failure).toBe('failed to spawn: spawn claude ENOENT');

        const b = open();
        b.events().onProtocolError?.('thread/start response did not contain thread.id', { recoverable: false });
        expect(b.session.turnState).toBe('failed');
    });
});

describe('the host passes the detail through', () => {
    it('driverEvents forwards the second argument', () => {
        const src = readFileSync(new URL('../src/main/session-host.ts', import.meta.url), 'utf8')
            .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
        expect(src.match(/onProtocolError:\s*\(problem,\s*detail\)\s*=>\s*events\.onProtocolError\?\.\(problem,\s*detail\)/g) ?? []).toHaveLength(1);
    });
});
