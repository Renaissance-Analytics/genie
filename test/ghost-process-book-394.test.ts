import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ProcessBook } from '../src/main/process-book.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { ProcessBookReplica, ProcessesService } from '../src/main/processes-host.js';

it('story394: the kept-process API hides asleep workspace rows and restores their unchanged specs on redock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genie2-process-ghost-394-'));
    let asleep = false, n = 0;
    const pty: PtyPort = { open: () => ({ id: `test-${++n}`, pid: 5000 + n, shell: 'test', scrollback: '' }), write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} };
    const supervisor = new ProcessSupervisor(pty, { now: () => 0, schedule: () => () => {} });
    try {
        const book = await ProcessBook.open(dir, { supervisor, envFor: () => ({}), asleep: (id) => id === 'ghost' && asleep });
        const active = await book.create({ workspaceId: 'awake', workspacePath: dir, name: 'Active', command: 'test', restart: 'never' });
        const ghost = await book.create({ workspaceId: 'ghost', workspacePath: dir, name: 'Dormant', command: 'test', restart: 'never' });
        const service = new ProcessesService({ book });
        const replica = new ProcessBookReplica((method, args) => service.call(method, args));
        replica.rebase(service.dump()); service.onEvent((dump) => replica.rebase(dump));
        const refresh = () => (book as unknown as { visibilityChanged?: () => void }).visibilityChanged?.();
        const before = book.list(); expect(before.map((process) => process.id)).toContain(ghost.id);
        asleep = true; refresh(); expect(replica.list().map((p) => p.id)).toEqual([active.id]);
        expect(replica.kept().map((p) => p.id)).toEqual([active.id]);
        asleep = true; expect(book.list().map((process) => process.id)).toEqual([active.id]);
        expect(book.kept().map((process) => process.id)).toEqual([active.id]);
        asleep = false; refresh(); expect(book.list()).toEqual(before); expect(replica.list()).toEqual(before);
    } finally { for (const process of supervisor.list()) supervisor.stop(process.id); await rm(dir, { recursive: true, force: true }); }
});
