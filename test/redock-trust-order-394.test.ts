import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { WorkspaceRef } from '../src/main/envelope-sites-host.js';
import { wakeWorkspace, type WorkspaceOpsPorts } from '../src/main/workspace-ops-host.js';
import { hostingRig, type HostingRig } from './helpers/hosting-rig.js';

function fixture(verify: () => Promise<void>) {
    const events: string[] = [];
    let asleep = true;
    const ports = { registry: { workspace: () => ({ id: 'workspace', path: '/fixture', asleep }),
        setAsleep: async (_id: string, value: boolean) => { asleep = value; events.push('awake', 'agents', 'sites', 'flows', 'config'); return true; },
    }, reverifyTrustBeforeRedock: async () => { events.push('verify'); await verify(); events.push('verified'); },
    engines: { toResume: () => ['database'], start: async () => { events.push('engine'); } },
    } as unknown as WorkspaceOpsPorts;
    return { ports, events, asleep: () => asleep };
}

it('story394: redock awaits fresh host trust before metadata can activate any agent/site/flow/config/engine work', async () => {
    let release!: () => void;
    const f = fixture(() => new Promise<void>((resolve) => { release = resolve; }));
    const waking = wakeWorkspace(f.ports, 'workspace');
    try { expect(f.events).toEqual(['verify']); expect(f.asleep()).toBe(true); }
    finally { release?.(); }
    expect(await waking).toMatchObject({ ok: true });
    expect(f.events).toEqual(['verify', 'verified', 'awake', 'agents', 'sites', 'flows', 'config', 'engine']);
});

it('story394: failed host trust verification keeps the workspace asleep and activates nothing', async () => {
    const f = fixture(async () => { throw new Error('trust unavailable'); });
    expect(await wakeWorkspace(f.ports, 'workspace')).toMatchObject({ ok: false, reason: expect.stringMatching(/trust unavailable/) });
    expect(f.asleep()).toBe(true); expect(f.events).toEqual(['verify']);
});

/*
 * Since 2g-4d E2b (Tynn #955) the redock's trust read is genie-host's own: its workspace lifecycle asks its own hosting's
 * trust (genie-host.ts `reverifyTrust`), with no window and no replica between. What #394 needs of it there: the redock
 * purpose reaches the trust that owns the record, and a hidden (asleep) registered folder is never taken for a new one.
 */
let r: HostingRig | null = null;
const strays: string[] = [];
afterEach(async () => { await r?.close(); r = null; for (const d of strays.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** genie-host's hosting over one registered workspace whose `asleep` the test moves (the registry's workspaceStates()). */
async function hostWith() {
    const workspace: { id: string; path: string; asleep: boolean } = { id: 'workspace', path: '', asleep: false };
    r = await hostingRig({ workspaces: (ws) => { workspace.path = ws; return [workspace as WorkspaceRef]; } });
    return { r, workspace };
}

it('story394: the redock purpose reaches genie-host’s own trust: an asleep workspace is read for its redock, and only then', async () => {
    const { r, workspace } = await hostWith();
    // The person's yes while awake (genie-host's own record).
    expect(await r.stack.trust.trust('workspace')).toMatchObject({ trusted: true });
    workspace.asleep = true;
    // CONTROL: an ordinary read of an asleep workspace reads nothing and believes no yes.
    expect(await r.stack.trust.refresh('workspace')).toBeNull();
    expect(r.stack.trust.isTrustedPath(workspace.path)).toBe(false);
    // The redock's read is the fresh one the wake waits for: it reads the folder, and the person's yes stands.
    expect(await r.stack.trust.refresh('workspace', 'redock')).toMatchObject({ trusted: true });
});

it('story394: a hidden registered folder is refused by genie-host’s own trust rather than mistaken for a new folder', async () => {
    const { r, workspace } = await hostWith();
    await r.stack.trust.trust('workspace');
    // CONTROL: awake and trusted, Genie's files may go in.
    expect(await r.stack.trust.mayWriteInto(workspace.path)).toBe(true);
    workspace.asleep = true;
    expect(await r.stack.trust.mayWriteInto(workspace.path)).toBe(false);
    // A folder that is no workspace is not this rule's.
    const elsewhere = mkdtempSync(join(tmpdir(), 'genie-394-new-'));
    strays.push(elsewhere);
    expect(await r.stack.trust.mayWriteInto(elsewhere)).toBe(true);
});

it('story394, wired: genie-host hands its hosting every registered workspace (asleep ones included), and its redock asks for the redock read', () => {
    const host = readFileSync('src/main/genie-host.ts', 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
    expect(host).toMatch(/hosting = await composeHosting\(\{[\s\S]{0,4000}?workspaces: \(\) => hostRegistry\.workspaceStates\(\),/);
    expect(host).toMatch(/reverifyTrust: async \(id\) => \{\s*if \(!hostingStack\) throw new Error\('workspace trust is not available yet'\);\s*await hostingStack\.trust\.refresh\(id, 'redock'\);/);
});
