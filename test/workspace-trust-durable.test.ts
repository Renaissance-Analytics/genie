import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trustHash, trustVerdict } from '../src/core/workspace-trust.js';
import { WorkspaceTrust, readTrustList, type WorkspaceTrustPorts } from '../src/main/workspace-trust-host.js';

/**
 * TRUST IS GIVEN ONCE AND STAYS (Tynn #618; the owner's ruling, 2026-11-11: "once I trust a workspace, it should be trusted
 * with everything in that workspace. I should not have to keep re-trusting it every time it adds a new service or site or
 * whatever."). A workspace's trust is the person's yes, kept on this machine, and ended only by the person's Untrust.
 * Nothing the workspace adds or changes ends it, and no change to Genie does: beta.61 changed how a workspace's list was
 * hashed, every stored hash stopped matching, and every trusted workspace was untrusted by the upgrade.
 *
 * So nothing is compared any more. The list of what a workspace would run is still read, to show the person what they
 * are saying yes to the first time.
 */
const W = join('/ws', 'acme');
const at = (...parts: string[]) => join(W, ...parts);
const hooked = (command: string) => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } });
/** A hash beta.60's own code stored for a workspace with wide allow rules: no formula of today reproduces it. */
const BETA60_RECORD = 'c5799739b315900cf865f132ac008a2d53220d4d7cdb96c368f45960dfc69b43';

function rig(files: Record<string, string>, over: { carried?: string[]; workspaces?: Record<string, string> } = {}) {
    const map = new Map(Object.entries(files));
    const record = { carried: [...(over.carried ?? [])], workspaces: { ...(over.workspaces ?? {}) } as Record<string, string> };
    const saved: string[] = [];
    const moved: string[] = [];
    const ports = {
        readText: async (path: string) => map.get(path) ?? null,
        gitConfig: async () => [],
        isTracked: async () => false,
        workspaces: () => [{ id: 'acme', path: W }],
        record: () => record,
        recordWorkspace: async (id: string, hash: string) => { record.workspaces[id] = hash; saved.push(hash); },
        forgetWorkspace: async (id: string) => { delete record.workspaces[id]; record.carried = record.carried.filter((c) => c !== id); },
        approveSites: async () => {},
        verdictMoved: (id: string) => { moved.push(id); },
    } as unknown as WorkspaceTrustPorts;
    const trust = new WorkspaceTrust(ports);
    /** The person's Untrust (not in the type before the change: red at run time, not at the type-check). */
    const untrust = (id: string) => (trust as unknown as { untrust(id: string): Promise<unknown> }).untrust(id);
    return { trust, untrust, record, saved, moved, files: map, ports };
}
const SETTINGS = at('.claude', 'settings.json');

describe('every workspace trusted before stays trusted after an upgrade, with no prompt', () => {
    it('a record beta.60 wrote, which no hash of today matches: trusted, and the record is left as it is', async () => {
        const r = rig({ [SETTINGS]: hooked('npm run lint') }, { workspaces: { acme: BETA60_RECORD } });
        expect(trustHash(await readTrustList(W, r.ports))).not.toBe(BETA60_RECORD); // CONTROL: it really does not match.
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: true, changed: false });
        expect(r.saved).toEqual([]);
        expect(r.record.workspaces.acme).toBe(BETA60_RECORD);
    });

    it('a record of any form at all', async () => {
        for (const recorded of ['older', 'v9:whatever', '']) {
            const r = rig({ [SETTINGS]: hooked('x') }, { workspaces: { acme: recorded } });
            expect(await r.trust.refresh('acme'), JSON.stringify(recorded)).toMatchObject({ trusted: true, changed: false });
        }
    });

    it('carried over at the first upgrade, with no record of its own: trusted, and it stays so when its files change', async () => {
        const r = rig({ [SETTINGS]: hooked('x') }, { carried: ['acme'] });
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: true, changed: false });
        r.files.set(SETTINGS, hooked('y'));
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: true, changed: false });
    });

    it('the verdict reads the record and nothing else', () => {
        expect(trustVerdict({ carried: [], workspaces: { acme: 'older' } }, 'acme', 'the-hash-now')).toEqual({ trusted: true, changed: false });
        expect(trustVerdict({ carried: ['acme'], workspaces: { acme: 'older' } }, 'acme', 'the-hash-now')).toEqual({ trusted: true, changed: false });
    });
});

describe('nothing a trusted workspace adds or changes untrusts it', () => {
    it('a hook, a server, an env setting, a site, a git key: still trusted, never "changed", and the verdict never moves', async () => {
        const r = rig({ [SETTINGS]: hooked('x') });
        expect(await r.trust.trust('acme')).toMatchObject({ trusted: true });
        const movedAtTrust = r.moved.length;
        r.files.set(SETTINGS, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'something-else' }] }], PreToolUse: [{ hooks: [{ type: 'command', command: 'another' }] }] }, env: { NODE_OPTIONS: '--require x' } }));
        r.files.set(at('.mcp.json'), JSON.stringify({ mcpServers: { theirs: { command: 'node', args: ['server.js'] } } }));
        r.files.set(at('.codex', 'config.toml'), '[mcp_servers.more]\ncommand = "node"\nargs = ["more.js"]\n');
        r.files.set(at('project.json'), JSON.stringify({ name: 'Acme', sites: { k1: { repo: '', runMode: 'host', kind: 'http', enabled: true, name: 'web', genName: 'web.gen', command: ['serve-it', '--port=9000'] } } }));
        const view = await r.trust.refresh('acme');
        expect(view).toMatchObject({ trusted: true, changed: false });
        // The list is still read, for anyone who wants to look.
        expect(view!.list.hooks.length).toBeGreaterThan(1);
        expect(view!.list.servers).toHaveLength(2);
        // Agents restart for trust when the verdict moves; it did not.
        expect(r.moved).toHaveLength(movedAtTrust);
        expect(r.trust.isTrustedPath(at('repos', 'shop'))).toBe(true);
    });
});

describe('never said yes (CONTROLS)', () => {
    it('a workspace with something that would run and no yes: not trusted, and never called "changed"', async () => {
        const r = rig({ [SETTINGS]: hooked('x') });
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: false, changed: false });
    });

    it('nothing would run: trusted without asking, nothing recorded', async () => {
        const r = rig({});
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: true, changed: false });
        expect(r.record.workspaces).toEqual({});
    });
});

describe('only the person\'s Untrust ends it', () => {
    it('Untrust: not trusted any more, its record gone, and it stays so until the person trusts it again', async () => {
        const r = rig({ [SETTINGS]: hooked('x') });
        await r.trust.trust('acme');
        expect(r.trust.view('acme')).toMatchObject({ trusted: true });
        expect(await r.untrust('acme')).toMatchObject({ trusted: false, changed: false });
        expect(r.record.workspaces.acme).toBeUndefined();
        expect(r.trust.isTrustedPath(W)).toBe(false);
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: false });
        expect(r.moved.at(-1)).toBe('acme');
        expect(await r.trust.trust('acme')).toMatchObject({ trusted: true });
    });

    it('a carried workspace can be untrusted too', async () => {
        const r = rig({ [SETTINGS]: hooked('x') }, { carried: ['acme'] });
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: true });
        await r.untrust('acme');
        expect(r.record.carried).toEqual([]);
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: false });
    });

    it('a workspace Genie does not have: nothing to untrust', async () => {
        expect(await rig({}).untrust('nobody')).toBeNull();
    });
});
