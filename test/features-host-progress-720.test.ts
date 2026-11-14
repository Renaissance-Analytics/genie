import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALLER_A, CALLER_B, deferred, presentationFixture, type PresentationFixture } from './helpers/features-host-presentation.js';

let f: PresentationFixture;
beforeEach(async () => { f = await presentationFixture(); });
afterEach(async () => { await f?.close(); vi.restoreAllMocks(); });
const repair = () => f.invoke({ kind: 'toolchain.repairCli', tool: 'claude-code' });

describe('host feature work has one shared progress owner (Tynn #720)', () => {
    it('CLI Repair runs the real vendor plan and ends with its measured health and result', async () => {
        const answer = await f.answer({ kind: 'toolchain.repairCli', tool: 'claude-code' });
        expect(f.cli.calls).toBeGreaterThan(0); expect(f.cli.steps.every(timeout => Number(timeout) > 0)).toBe(true);
        expect(answer.toolchain?.result).toBe('Claude Code 2.1.0 is installed and answers.');
        expect(answer.toolchain?.updating).toBeUndefined();
    });
    it('a failed real CLI repair keeps the actual failure on the initiating caller row', async () => {
        f.cli.fail = true;
        const answer = await f.answer({ kind: 'toolchain.repairCli', tool: 'claude-code' });
        expect(answer.toolchain?.refusals).toEqual([{ tool: 'claude-code', reason: expect.stringContaining('fixture repair refused') }]);
        expect((await f.snapshot(CALLER_B)).toolchain?.refusals ?? []).toEqual([]);
    });
    it('a real runner rejection ends repair progress and preserves why it failed', async () => {
        f.cli.throw = true;
        const answer = await f.answer({ kind: 'toolchain.repairCli', tool: 'claude-code' });
        expect(answer.toolchain?.refusals).toEqual([{ tool: 'claude-code', reason: expect.stringContaining('fixture runner disconnected') }]);
        expect(answer.toolchain?.updating).toBeUndefined();
    });
    it('a held CLI repair is visible to another caller and generic invalidations before it finishes', async () => {
        f.cli.hold = true; const changes = f.changes(); let ended = false;
        const pending = repair().then(result => { ended = true; return result; }); await f.settle();
        try {
            expect(f.cli.calls).toBe(1); expect(ended).toBe(false);
            expect((await f.snapshot(CALLER_B)).toolchain?.updating).toMatchObject({ tool: 'claude-code' });
            expect(changes.snapshots.some(data => data.toolchain?.updating?.tool === 'claude-code')).toBe(true);
        } finally { f.cli.finish.resolve(); await pending; }
        expect(await pending).toMatchObject({ ok: true }); await f.settle();
        expect(changes.snapshots.at(-1)?.toolchain?.updating).toBeUndefined();
    });
    it('another caller cannot start a duplicate installer or clear the running repair row', async () => {
        f.cli.hold = true; const first = repair(); await f.settle();
        try {
            expect(f.cli.calls).toBe(1);
            await f.answer({ kind: 'toolchain.repairCli', tool: 'claude-code' }, CALLER_B);
            expect(f.cli.calls).toBe(1); expect((await f.snapshot(CALLER_B)).toolchain?.updating).toMatchObject({ tool: 'claude-code' });
        } finally { f.cli.finish.resolve(); await first; }
    });
    it('existing Update callbacks reach both callers and the generic source while the updater is held', async () => {
        await f.answer({ kind: 'toolchain.check', force: true });
        const finish = deferred(); f.holds.push(() => finish.resolve());
        Object.assign(f.toolchain, { update: async (_tool: string, _version: string | undefined, progress?: (step: string | null) => void) => {
            progress?.('fixture verified download'); await finish.promise; return { kind: 'refused', reason: 'fixture update not applied' };
        } });
        const changes = f.changes(), pending = f.invoke({ kind: 'toolchain.update', tool: 'git', version: '2.51.0' });
        await f.settle();
        try {
            expect((await f.snapshot(CALLER_B)).toolchain?.updating).toEqual({ tool: 'git', version: '2.51.0', step: 'fixture verified download' });
            expect(changes.snapshots.some(data => data.toolchain?.updating?.step === 'fixture verified download')).toBe(true);
        } finally { finish.resolve(); await pending; }
        await f.settle(); expect((await f.snapshot(CALLER_B)).toolchain?.updating).toBeUndefined();
    });
    it('shared work progress never broadcasts the initiating caller query or form', async () => {
        await f.answer({ kind: 'knowledge.search', query: 'private caller query' });
        await f.answer({ kind: 'knowledge.openAdd', workspaceId: 'work' });
        f.cli.hold = true; const changes = f.changes(), pending = repair(); await f.settle();
        try {
            expect(changes.snapshots.some(data => data.toolchain?.updating?.tool === 'claude-code')).toBe(true);
            expect(changes.snapshots.every(data => data.knowledge.query === '' && data.knowledge.adding === null)).toBe(true);
        } finally { f.cli.finish.resolve(); await pending; }
    });
    it('disconnecting a repair caller keeps shared work visible without restoring that caller view', async () => {
        await f.answer({ kind: 'knowledge.search', query: 'old caller' });
        f.cli.hold = true; const pending = repair(); await f.settle();
        try {
            expect(f.cli.calls).toBe(1); f.service.releaseCaller(CALLER_A);
            expect((await f.snapshot(CALLER_B)).toolchain?.updating).toMatchObject({ tool: 'claude-code' });
        } finally { f.cli.finish.resolve(); await pending; }
        expect((await f.snapshot()).knowledge.query).toBe('');
    });
    it('CONTROL: the real repair planner runs with inert OS ports independently of feature routing', async () => {
        const outcome = await f.toolchain.repairCli!('claude', () => {});
        expect(outcome.kind).toBe('repaired'); expect(f.cli.calls).toBeGreaterThan(0);
        expect(f.cli.steps.every(timeout => Number(timeout) > 0)).toBe(true);
    });
    it('CONTROL: a failed generic build logs its failure and the next change recovers', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {}), changes = f.changes();
        vi.spyOn(f.knowledge, 'summaries').mockRejectedValueOnce(new Error('fixture build unavailable'));
        f.changed(); await f.settle(); expect(error).toHaveBeenCalledWith('[genie] push:', 'fixture build unavailable');
        f.changed(); await f.settle(); expect(changes.snapshots.length).toBeGreaterThan(0);
    });
});
