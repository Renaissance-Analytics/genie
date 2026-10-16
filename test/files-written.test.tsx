import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesHost } from '../src/main/files-host.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * FILES WRITTEN (the board's blind index for an observed agent): what changed on disk since the Take Over window
 * opened, with when Genie saw it — and NOT attributed: a Take Over window reports nothing, so the author is not
 * guessed. The host keeps the time of every disk change it sees; the Activity tab lists the ones since the window's
 * start, or says `None yet.` (a measured nothing).
 */
describe('the host keeps when it saw each disk change', () => {
    let root: string;
    let host: FilesHost;
    let now = 1_760_000_000_000;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'genie2-written-'));
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src', 'a.ts'), 'a\n');
        now = 1_760_000_000_000;
        host = new FilesHost({ workspace: (id) => (id === 'tynn' ? { id: 'tynn', path: root } : null), agentsOf: () => [], eventsOf: () => [], now: () => now });
    });
    afterEach(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });

    it('diskChanges carries the path and the clock, newest first; empty before anything changed', async () => {
        expect((await host.state('tynn'))!.diskChanges).toEqual([]);
        await host.watch('tynn');
        now = 1_760_000_005_000;
        await writeFile(join(root, 'src', 'a.ts'), 'b\n');
        await vi.waitFor(async () => { expect((await host.state('tynn'))!.diskChanges).toEqual([{ path: 'src/a.ts', at: 1_760_000_005_000 }]); }, { timeout: 5_000, interval: 50 });
        now = 1_760_000_009_000;
        await writeFile(join(root, 'mystery.ts'), 'x\n');
        // Linux can report one write as two events, so src/a.ts may be seen again after the clock moved: the
        // contract is the set, the newer file's own time, and newest-first order, not which event came last.
        await vi.waitFor(async () => {
            const seen = (await host.state('tynn'))!.diskChanges;
            expect(seen.map((c) => c.path).sort()).toEqual(['mystery.ts', 'src/a.ts']);
            expect(seen).toContainEqual({ path: 'mystery.ts', at: 1_760_000_009_000 });
            expect(seen.map((c) => c.at)).toEqual([...seen.map((c) => c.at)].sort((a, b) => b - a));
        }, { timeout: 5_000, interval: 50 });
    });
});

describe('the Activity tab', () => {
    const agent = { id: 'k1', name: 'kora', provider: 'claude', fidelity: 'observed' as const, cwd: '/w/tynn', instructions: null };
    const render = (disk: { path: string; at: number }[] | null, startedAt: number) =>
        renderToStaticMarkup(<AgentView agent={agent} session={null} rows={[]} tab="activity" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 100_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} takeOver={{ terminalId: 't1', startedAt, lastOutputAt: null, bursts: [] }} initialDiskChanges={disk} />);

    it('lists the changes since the window opened, says they are not attributed, and leaves out the earlier ones', () => {
        const html = render([{ path: 'src/a.ts', at: 60_000 }, { path: 'old.ts', at: 10_000 }], 50_000);
        expect(html).toContain('data-observed-files-written="k1"');
        expect(html).toContain('not attributed');
        expect(html).toContain('data-observed-file="src/a.ts"');
        expect(html).not.toContain('data-observed-file="old.ts"');
    });

    it('`None yet.` with nothing since the start (a measured nothing); no section at all without the disk state', () => {
        expect(render([{ path: 'old.ts', at: 10_000 }], 50_000)).toContain('data-observed-files-none=""');
        expect(render(null, 50_000)).not.toContain('data-observed-files-written');
    });
});
