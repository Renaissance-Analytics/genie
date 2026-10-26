import { describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import {
    ATTACHMENT_LIMITS,
    HUMAN,
    agentAddress,
    attachmentRefusal,
    isExecutableName,
    parseAddress,
    reachable,
    resolveAddress,
} from '../src/core/inbox.js';

/**
 * AGENTINBOX — the pure half (§6.4): addressing, reachability, attachment rules.
 *
 * Nothing here touches a disk or a clock. The durable half is `test/inbox-store.test.ts`.
 */

const agent = (workspaceId: string, provider: 'claude' | 'codex', name: string, accessScope: AgentRecord['accessScope'] = 'self') =>
    agentRecord({ id: mintAgentId(), workspaceId, provider, name, accessScope });

describe('addressing', () => {
    // name@workspace is test/inbox-agent-at.test.ts; here, the OLD provider forms that must keep resolving.
    it('the old provider forms parse, and malformed ones do not', () => {
        expect(parseAddress('claude:fancy')).toEqual({ workspace: null, provider: 'claude', name: 'fancy' });
        expect(parseAddress('tynn:claude:fancy')).toEqual({ workspace: 'tynn', provider: 'claude', name: 'fancy' });
        // COUNTED: three malformed inputs, three nulls. A parser that accepted one of them would
        // route mail to an agent nobody named.
        const bad = ['a:b:c:d', ':fancy', 'claude:'].map(parseAddress);
        expect(bad.filter((a) => a === null)).toHaveLength(3);
    });

    it('an old short form still names its provider: same name, other provider, not ambiguous', () => {
        const fancy = agent('fancy', 'claude', 'fancy');
        const roster = [fancy, agent('tynn', 'claude', 'tynn'), agent('prism', 'codex', 'fancy')];
        expect(resolveAddress('claude:fancy', roster)).toEqual({ kind: 'one', id: fancy.id });
        expect(resolveAddress('codex:fancy', roster)).toEqual({ kind: 'one', id: roster[2]!.id });
    });

    it('two agents sharing an old short form: AMBIGUOUS, named as name@workspace; the old full form resolves', () => {
        const a = agent('tynn', 'claude', 'review');
        const b = agent('fancy', 'claude', 'review');
        const r = resolveAddress('claude:review', [a, b]);
        expect(r).toEqual({ kind: 'ambiguous', forms: ['review@tynn', 'review@fancy'] });
        expect(resolveAddress('fancy:claude:review', [a, b])).toEqual({ kind: 'one', id: b.id });
    });

    it('resolves nobody to `none`, never to a guess', () => {
        expect(resolveAddress('claude:ghost', [agent('tynn', 'claude', 'tynn')])).toEqual({ kind: 'none' });
        expect(resolveAddress('not an address', [agent('tynn', 'claude', 'tynn')])).toEqual({ kind: 'none' });
    });

    it('the human is a first-class participant with a fixed address', () => {
        expect(resolveAddress('human', [])).toEqual({ kind: 'human' });
        expect(resolveAddress('you', [])).toEqual({ kind: 'human' });
    });

    it('formats name@workspace from a record (the id when no slug is known)', () => {
        const a = agent('tynn', 'claude', 'tynn');
        expect(agentAddress(a, new Map())).toBe('tynn@tynn');
        expect(agentAddress(a, new Map([['tynn', 'tynn-ai']]))).toBe('tynn@tynn-ai');
    });
});

describe('reachable — PERMISSION, not liveness', () => {
    const allow = (scope: 'none' | 'self' | 'specific' | 'all', workspaces: string[] = []) =>
        () => ({ scope, workspaces });

    it('two agents in one workspace reach each other under the defaults', () => {
        const a = agent('tynn', 'claude', 'a');
        const b = agent('tynn', 'claude', 'b');
        expect(reachable(a, b, allow('self'))).toBe(true);
    });

    it('cross-workspace needs BOTH tiers: the target workspace setting AND the target agent scope', () => {
        const a = agent('tynn', 'claude', 'a');
        // Workspace says all, agent says self → no.
        const bSelf = agent('fancy', 'claude', 'b', 'self');
        expect(reachable(a, bSelf, allow('all'))).toBe(false);
        // Agent says all, workspace says self → no.
        const bAll = agent('fancy', 'claude', 'b', 'all');
        expect(reachable(a, bAll, allow('self'))).toBe(false);
        // Both say all → yes. The POSITIVE CONTROL for the two refusals above.
        expect(reachable(a, bAll, allow('all'))).toBe(true);
    });

    it('`specific` names workspaces, and is checked at both tiers', () => {
        const a = agent('tynn', 'claude', 'a');
        const b = agent('fancy', 'claude', 'b', 'specific');
        expect(reachable(a, b, allow('specific', ['tynn']), { agentWorkspaces: ['tynn'] })).toBe(true);
        expect(reachable(a, b, allow('specific', ['prism']), { agentWorkspaces: ['tynn'] })).toBe(false);
        expect(reachable(a, b, allow('specific', ['tynn']), { agentWorkspaces: ['prism'] })).toBe(false);
    });

    it('`none` is unreachable even from the same workspace', () => {
        const a = agent('tynn', 'claude', 'a');
        const b = agent('tynn', 'claude', 'b', 'none');
        expect(reachable(a, b, allow('all'))).toBe(false);
    });

    it('the human reaches every agent, and every agent reaches the human', () => {
        const hidden = agent('fancy', 'claude', 'b', 'none');
        expect(reachable(HUMAN, hidden, allow('none'))).toBe(true);
        expect(reachable(hidden, HUMAN, allow('none'))).toBe(true);
    });
});

describe('attachments — the rules both ends enforce', () => {
    const MB = 1024 * 1024;

    it('states the caps the spec names', () => {
        expect(ATTACHMENT_LIMITS).toEqual({ perFileBytes: 25 * MB, perMessageBytes: 40 * MB, files: 10 });
    });

    it('refuses natively-executable names and accepts source files', () => {
        // COUNTED on both sides: a refusal list that also caught `.sh`/`.js` would refuse the
        // files agents most often share; one that missed `.cmd` would ship a shim.
        const refused = ['a.exe', 'b.msi', 'c.bat', 'd.cmd', 'e.com', 'f.scr', 'g.ps1', 'h.vbs', 'i.dll', 'j.dmg', 'k.AppImage', 'l.EXE'];
        expect(refused.filter(isExecutableName)).toHaveLength(refused.length);
        const accepted = ['a.sh', 'b.js', 'c.ts', 'd.md', 'e.png', 'f.json', 'g', 'h.tar.gz'];
        expect(accepted.filter(isExecutableName)).toHaveLength(0);
    });

    it('accepts a message at the caps and refuses one byte over each of them', () => {
        const ok = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.md`, size: 4 * MB }));
        expect(attachmentRefusal(ok)).toBeNull();

        expect(attachmentRefusal([{ name: 'big.md', size: 25 * MB + 1 }])).toMatch(/big\.md.*25 MB/);
        expect(attachmentRefusal([{ name: 'a.md', size: 20 * MB }, { name: 'b.md', size: 20 * MB + 1 }])).toMatch(/40 MB/);
        expect(attachmentRefusal(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.md`, size: 1 })))).toMatch(/10 files/);
        expect(attachmentRefusal([{ name: 'ok.md', size: 1 }, { name: 'run.exe', size: 1 }])).toMatch(/run\.exe.*executable/);
    });
});
