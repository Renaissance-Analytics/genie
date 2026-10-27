import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import type { Caller } from '../src/main/mcp-tools.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * A PERMISSION SWITCH THE PERSON TURNED ON IS THEIR ANSWER (genie#1294; the owner, 2026-10-27 on beta.49: an agent with
 * "May manage workspace tabs" and "May drive pages" on was still asked, every time, to drive a site in the Genie browser).
 *
 * Checked through the COMPOSITION ROOT (compose.ts builds the one ApprovalQueue every tool's `approve` goes to), with the
 * agent's record on the roster, so what is checked is the wiring the running Genie has:
 * - "May drive pages" on → a page submit and a destructive page click go through: nothing parks on the Deck, and the
 *   action is recorded with the other approvals the person did not have to give.
 * - "May manage workspace tabs" on → a tab change goes through the same way.
 * - CONTROLS: without the switch it still asks (the default agent included — it has the tool, not the answer); autonomy
 *   alone still does not answer a page submit; a switch answers only its own actions, never another switch's, never
 *   another tool's, and never creating an agent.
 */

const noPty: PtyPort = {
    open: () => { throw new Error('no pty in this test'); },
    write: () => false,
    resize: () => false,
    kill: () => false,
    scrollback: () => '',
    onData: () => () => {},
    onExit: () => () => {},
};

let dir: string;
let services: ComposedServices;
let roster: AgentRecord[];

const agent = (id: string, extra: Partial<AgentRecord> = {}): void => {
    roster.push({ id, workspaceId: 'shop', provider: 'claude', name: id, instructions: null, threadId: null, createdAt: '2026-10-27T00:00:00.000Z', lastUsedAt: null, ...extra } as never);
};
const caller = (id: string): Caller => ({ agentId: id as never, agentName: id, workspaceId: 'shop', workspacePath: dir }) as Caller;

/** The verdict now, or 'asked' when the request parked on the Deck for the person. */
async function verdictOf(id: string, action: string, detail = 'Save on https://shop.gen/projects'): Promise<'allowed' | 'denied' | 'asked'> {
    let settled: 'allowed' | 'denied' | null = null;
    void services.approvals.gate(caller(id), action, detail).then((v) => { settled = v; });
    await new Promise((r) => setTimeout(r, 0));
    return settled ?? 'asked';
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-1294-'));
    roster = [];
    services = await composeServices({ userData: dir, pty: noPty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster });
});

afterEach(async () => {
    services.approvals.cancelAll('test over');
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('"May drive pages" on: driving a site does not ask', () => {
    it('a page SUBMIT goes through — nothing on the Deck — and is recorded', async () => {
        agent('a_driver', { drivePages: true, manageTabs: true });
        expect(await verdictOf('a_driver', 'page.submit')).toBe('allowed');
        expect(services.approvals.deckItems()).toEqual([]);
        expect(services.approvals.autoApproved().map((a) => [a.agentId, a.action])).toEqual([['a_driver', 'page.submit']]);
    });

    it('a DESTRUCTIVE click goes through the same way', async () => {
        agent('a_driver', { drivePages: true });
        expect(await verdictOf('a_driver', 'page.click', 'click “Delete project” on https://shop.gen/projects')).toBe('allowed');
        expect(services.approvals.deckItems()).toEqual([]);
    });
});

describe('"May manage workspace tabs" on: a tab change does not ask', () => {
    it('placing a site panel goes through and is recorded', async () => {
        agent('a_tabs', { manageTabs: true });
        expect(await verdictOf('a_tabs', 'workspace.tabs', 'Show shop.gen in panel 1 of “Site”')).toBe('allowed');
        expect(services.approvals.deckItems()).toEqual([]);
        expect(services.approvals.autoApproved().map((a) => a.action)).toEqual(['workspace.tabs']);
    });
});

describe('CONTROLS: without the switch it still asks', () => {
    it('an agent with neither switch: a submit, a destructive click and a tab change each wait on the Deck', async () => {
        agent('a_plain');
        expect(await verdictOf('a_plain', 'page.submit')).toBe('asked');
        expect(await verdictOf('a_plain', 'page.click', 'click “Delete”')).toBe('asked');
        expect(await verdictOf('a_plain', 'workspace.tabs', 'Add a tab “Site”')).toBe('asked');
        expect(services.approvals.deckItems()).toHaveLength(3);
        expect(services.approvals.autoApproved()).toEqual([]);
    });

    it('a switch answers ONLY its own actions: drive pages ≠ tabs, tabs ≠ pages', async () => {
        agent('a_driver', { drivePages: true });
        agent('a_tabs', { manageTabs: true });
        expect(await verdictOf('a_driver', 'workspace.tabs', 'Add a tab “Site”')).toBe('asked');
        expect(await verdictOf('a_tabs', 'page.submit')).toBe('asked');
    });

    it('neither switch answers another tool’s action, nor creating an agent', async () => {
        agent('a_both', { drivePages: true, manageTabs: true });
        expect(await verdictOf('a_both', 'processes.add', 'npm run dev')).toBe('asked');
        expect(await verdictOf('a_both', 'write', 'rm -rf build')).toBe('asked');
        expect(await verdictOf('a_both', 'agents.create', 'helper')).toBe('asked');
    });

    it('autonomy alone still does not answer a page submit (person-only stays person-only without the switch)', async () => {
        agent('a_auto', { autoApprove: true });
        expect(await verdictOf('a_auto', 'page.submit')).toBe('asked');
        // ...its ordinary gated actions do go through (the control that autonomy is wired at all).
        expect(await verdictOf('a_auto', 'processes.add', 'npm run dev')).toBe('allowed');
    });

    it('the switch is read at each ask: turned off, the next submit asks again', async () => {
        agent('a_driver', { drivePages: true });
        expect(await verdictOf('a_driver', 'page.submit')).toBe('allowed');
        roster[0] = { ...roster[0]!, drivePages: false };
        expect(await verdictOf('a_driver', 'page.submit', 'Save again')).toBe('asked');
    });
});
