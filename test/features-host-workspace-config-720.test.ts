import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CALLER_A, CALLER_B, RELEASE, workspaceCallerFixture, type WorkspaceCallerFixture } from './helpers/features-host-workspace-caller.js';

let f: WorkspaceCallerFixture;
beforeEach(async () => { f = await workspaceCallerFixture(); });
afterEach(async () => { await f?.close(); });
const trustAction = () => ({ kind: 'workspace.trust', workspaceId: 'work', workspacePath: f.workspace } as const);
const syncAction = () => ({ ...trustAction(), kind: 'workspace.syncAgentFiles' } as const);
const report = (data: Awaited<ReturnType<WorkspaceCallerFixture['snapshot']>>) => data.integrations?.lastSync;

describe('host workspace/config and explicit release notes use their owned services (Tynn #720)', () => {
    it('Trust records the real verdict before agent files and all four harness configs', async () => {
        const answer = await f.answer(trustAction());
        expect(f.order).toEqual(['trust', 'docs:you', 'config:you']);
        expect(f.hosting.trust.view('work')?.trusted).toBe(true);
        expect(report(answer)).toMatchObject({ workspaceId: 'work', results: [
            { id: 'claude', ok: true }, { id: 'cursor', ok: true }, { id: 'codex', ok: true }, { id: 'hooks', ok: true },
        ] });
        const mcp = JSON.parse(await f.read('.mcp.json'));
        expect(mcp.mcpServers.other).toEqual({ url: 'https://example.com/mcp' });
        expect(JSON.stringify(mcp)).toContain(f.endpoint.url);
        expect(await f.read('.agents/_genie/shared.md')).toContain('`fixture_tool`');
        expect(f.invokeWindow).not.toHaveBeenCalled();
    });
    it('Sync now uses the canonical writers and reports the actual four target results', async () => {
        await f.hosting.trust.trust('work'); const answer = await f.answer(syncAction());
        expect(f.order).toEqual(['docs:you', 'config:you']);
        expect(f.docs).toHaveBeenCalledExactlyOnceWith(f.workspace, 'you');
        expect(f.config).toHaveBeenCalledExactlyOnceWith(f.workspace, 'you');
        expect(report(answer)?.results.map(row => [row.id, row.ok])).toEqual([['claude', true], ['cursor', true], ['codex', true], ['hooks', true]]);
        expect(await f.read('.cursor/mcp.json')).toContain(f.endpoint.url);
        expect(await f.read('.codex/config.toml')).toContain(f.endpoint.url);
        expect(await f.read('.claude/settings.local.json')).toContain('Stop');
    });
    it('Untrust records the real withdrawal and leaves the existing config bytes alone', async () => {
        await f.hosting.trust.trust('work'); await f.config(f.workspace, 'you'); const before = await f.read('.mcp.json'); f.order.length = 0;
        await f.answer({ kind: 'workspace.untrust', workspaceId: 'work' });
        expect(f.order).toEqual(['untrust']); expect(f.hosting.trust.view('work')?.trusted).toBe(false);
        expect(await f.read('.mcp.json')).toBe(before); expect(f.docs).not.toHaveBeenCalled();
    });
    it('a missing Trust names the absent workspace before either writer is called', async () => {
        await expect(f.act({ ...trustAction(), workspaceId: 'absent' })).rejects.toThrow('There is no workspace "absent" to trust.');
        expect(f.docs).not.toHaveBeenCalled(); expect(f.config).not.toHaveBeenCalled();
    });
    it('a missing Untrust keeps the canonical refusal and leaves the actual workspace alone', async () => {
        await f.hosting.trust.trust('work');
        await expect(f.act({ kind: 'workspace.untrust', workspaceId: 'absent' })).rejects.toThrow('There is no workspace "absent" to untrust.');
        expect(f.hosting.trust.view('work')?.trusted).toBe(true);
    });
    it('a failed trust record rejects before either writer and retains the previous verdict', async () => {
        f.trust.mockRejectedValueOnce(new Error('fixture trust save failed'));
        await expect(f.act(trustAction())).rejects.toThrow('fixture trust save failed');
        expect(f.docs).not.toHaveBeenCalled(); expect(f.config).not.toHaveBeenCalled(); expect(f.hosting.trust.isTrustedPath(f.workspace)).toBe(false);
    });
    it('a failed Untrust keeps its thrown reason and the real prior trust', async () => {
        await f.hosting.trust.trust('work'); f.untrust.mockRejectedValueOnce(new Error('fixture withdrawal failed'));
        await expect(f.act({ kind: 'workspace.untrust', workspaceId: 'work' })).rejects.toThrow('fixture withdrawal failed');
        expect(f.hosting.trust.view('work')?.trusted).toBe(true);
    });
    it('an agent-file failure stops config sync while keeping a successfully recorded trust', async () => {
        f.faults.docs = true;
        await expect(f.act(trustAction())).rejects.toThrow('fixture protocol writer failed');
        expect(f.hosting.trust.view('work')?.trusted).toBe(true); expect(f.config).not.toHaveBeenCalled();
        expect(report(await f.snapshot())).toBeNull();
    });
    it('a config failure rejects without inventing a completed sync report', async () => {
        f.faults.config = true;
        await expect(f.act(trustAction())).rejects.toThrow('fixture config writer failed');
        expect(f.order).toEqual(['trust', 'docs:you', 'config:you']); expect(report(await f.snapshot())).toBeNull();
    });
    it('Sync now on an untrusted workspace keeps the real no-write outcome', async () => {
        const before = await f.read('.mcp.json'), answer = await f.answer(syncAction());
        expect(report(answer)).toEqual({ workspaceId: 'work', results: [] });
        expect(await f.read('.mcp.json')).toBe(before); expect(await f.fs.read(f.workspace + '/.agents/_genie/shared.md')).toBeNull();
    });
    it('a sync retry preserves the previous completed report until the real retry succeeds', async () => {
        const before = report(await f.answer(trustAction())); f.faults.config = true;
        await expect(f.act(syncAction())).rejects.toThrow('fixture config writer failed');
        expect(report(await f.snapshot())).toEqual(before); f.faults.config = false;
        expect(report(await f.answer(syncAction()))).toEqual(before);
    });
    it('a sync keeps that caller query and open form while retaining its own report', async () => {
        await f.answer({ kind: 'knowledge.search', query: 'caller query' }); await f.answer({ kind: 'knowledge.openAdd', workspaceId: 'work' });
        const answer = await f.answer(trustAction());
        expect(answer.knowledge.query).toBe('caller query'); expect(answer.knowledge.adding).not.toBeNull();
        expect(report(await f.snapshot())).toEqual(report(answer));
    });
    it('completed sync reports belong only to the caller that requested them', async () => {
        const answer = await f.answer(trustAction(), CALLER_A);
        expect(report(answer)).not.toBeNull(); expect(report(await f.snapshot(CALLER_B))).toBeNull();
    });
    it('generic changes never broadcast a caller sync report or explicit notes flag', async () => {
        const changes = f.changes(); await f.answer(trustAction()); await f.answer({ kind: 'whatsNew.show' });
        await f.settings.set('whats_new_seen_version', RELEASE); await f.settle();
        expect(changes.snapshots.length).toBeGreaterThan(0);
        expect(changes.snapshots.every(data => report(data) === null && data.whatsNew === null)).toBe(true);
    });
    it('explicit release notes reopen only for the requesting caller after the version was seen', async () => {
        await f.settings.set('whats_new_seen_version', RELEASE);
        const answer = await f.answer({ kind: 'whatsNew.show' }, CALLER_A);
        expect(answer.whatsNew).toEqual({ version: RELEASE, notes: 'Fixture user-facing notes.' });
        expect((await f.snapshot(CALLER_A)).whatsNew).toEqual(answer.whatsNew); expect((await f.snapshot(CALLER_B)).whatsNew).toBeNull();
    });
    it('closing release notes persists the seen version and clears that caller explicit flag', async () => {
        await f.answer({ kind: 'whatsNew.show' }); const answer = await f.answer({ kind: 'whatsNew.close', version: RELEASE });
        expect(answer.whatsNew).toBeNull(); expect(f.settings.get('whats_new_seen_version')).toBe(RELEASE); expect((await f.snapshot()).whatsNew).toBeNull();
    });
    it('one caller closing release notes never clears another caller explicit reopen', async () => {
        await f.answer({ kind: 'whatsNew.show' }, CALLER_A); await f.answer({ kind: 'whatsNew.show' }, CALLER_B);
        await f.answer({ kind: 'whatsNew.close', version: RELEASE }, CALLER_A);
        expect((await f.snapshot(CALLER_A)).whatsNew).toBeNull(); expect((await f.snapshot(CALLER_B)).whatsNew?.version).toBe(RELEASE);
    });
    it('CONTROL: the historical shared Trust path writes through these same real owners', async () => {
        const answer = await f.legacy(trustAction());
        expect(f.order).toEqual(['trust', 'docs:you', 'config:you']); expect(report(answer)?.results).toHaveLength(4);
        expect(await f.read('.agents/_genie/shared.md')).toContain('`fixture_tool`'); expect(await f.read('.mcp.json')).toContain(f.endpoint.url);
    });
    it('CONTROL: the historical missing-workspace refusal is the exact one pinned here', async () => {
        await expect(f.legacy({ ...trustAction(), workspaceId: 'absent' })).rejects.toThrow('There is no workspace "absent" to trust.');
        expect(f.docs).not.toHaveBeenCalled(); expect(f.config).not.toHaveBeenCalled();
    });
    it('CONTROL: the canonical writers themselves refuse to write into the untrusted folder', async () => {
        const before = await f.read('.mcp.json'); await f.docs(f.workspace, 'you'); expect(await f.config(f.workspace, 'you')).toEqual([]);
        expect(await f.read('.mcp.json')).toBe(before); expect(await f.fs.read(f.workspace + '/.agents/_genie/shared.md')).toBeNull();
    });
});
