import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS } from '../src/core/settings.js';
import { sectionOf } from '../src/core/settings-nav.js';
import { LIMIT_KEYS, limitOf, limitRefusal } from '../src/core/shell-limits.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { ProcessBook } from '../src/main/process-book.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import { TerminalHost, type PtyPort } from '../src/main/terminal-host.js';

/**
 * A SHELLS LIMITER, PER WORKSPACE (beta.33). The owner (2026-10-20): "we have too many running shells. we need to include
 * a shells limiter". His answers (FTQ q_98d1c350): count EVERYTHING, as SEPARATE limits — agents' shells, terminals,
 * background processes; PER WORKSPACE, kept as workspace settings on the workstation (Genie's own settings store — not
 * Tynn, not project.json); at the limit Genie REFUSES the new one and says the limit and what is running.
 *
 * This file: the limits themselves, and the two kinds that are Genie's own — terminals and background processes.
 */

describe('the limits are workspace settings on the workstation', () => {
    it('SEPARATE limits — terminals, background processes — each a per-workspace setting with a choice of numbers, under Defaults for workspaces', () => {
        for (const key of Object.values(LIMIT_KEYS)) {
            const def = SETTINGS.find((s) => s.key === key);
            expect(def, key).toMatchObject({ scope: 'workspace', type: 'enum' });
            expect(def && def.type === 'enum' ? def.options.every((o) => Number(o) > 0) : false, key).toBe(true);
            expect(sectionOf(key), key).toBe('workspace-defaults');
        }
        expect(new Set(Object.values(LIMIT_KEYS)).size).toBe(2);
        // An agent's own shells are not offered until Genie can gate them (measured first): no setting that does nothing.
        expect(SETTINGS.some((s) => s.key === 'limit_agent_shells')).toBe(false);
    });

    it('read forgivingly: a stored number is the limit; anything else is the default', () => {
        expect(limitOf({ limit_terminals: '4' }, 'terminals')).toBe(4);
        expect(limitOf({}, 'terminals')).toBe(Number(SETTINGS.find((s) => s.key === LIMIT_KEYS.terminals)!.default));
        expect(limitOf({ limit_terminals: 'lots' }, 'terminals')).toBe(Number(SETTINGS.find((s) => s.key === LIMIT_KEYS.terminals)!.default));
    });

    it('the refusal says the limit, what is running, and where to raise it; under the limit there is none', () => {
        expect(limitRefusal('terminals', 4, ['bash (pid 1)', 'bash (pid 2)', 'zsh (pid 3)'])).toBeNull();
        const r = limitRefusal('terminals', 3, ['bash (pid 1)', 'bash (pid 2)', 'zsh (pid 3)']);
        expect(r).toMatch(/3 terminals/);
        expect(r).toMatch(/bash \(pid 1\), bash \(pid 2\), zsh \(pid 3\)/);
        expect(r).toMatch(/Settings/);
        expect(limitRefusal('processes', 1, ['queue'])).toMatch(/1 background process\b/);
    });
});

/** A pty that records and never spawns. */
function fakePty() {
    const live = new Set<string>();
    let n = 0;
    const exits = new Set<(id: string, code: number) => void>();
    const port: PtyPort = {
        open: () => { n += 1; const id = `pty_${n}`; live.add(id); return { id, pid: 100 + n, shell: '/bin/bash', scrollback: '' }; },
        write: () => true,
        resize: () => true,
        kill: (id) => live.delete(id),
        scrollback: () => '',
        onData: () => () => {},
        onExit: (l) => { exits.add(l); return () => exits.delete(l); },
    };
    return { port, live, exit: (id: string) => { live.delete(id); for (const l of exits) l(id, 0); } };
}

describe('terminals: refused at the workspace limit', () => {
    const limits = (n: number) => ({ terminals: (_workspaceId: string) => n });

    it('the one past the limit is REFUSED with the limit and what is running; nothing is spawned (COUNTED)', () => {
        const pty = fakePty();
        const host = new TerminalHost(pty.port, limits(2));
        host.open({ workspaceId: 'example', cwd: '/w' });
        host.open({ workspaceId: 'example', cwd: '/w' });
        expect(() => host.open({ workspaceId: 'example', cwd: '/w' })).toThrow(/2 terminals[\s\S]*bash \(pid 101\), bash \(pid 102\)/);
        expect(pty.live.size).toBe(2);
        expect(host.refusal('example')).toMatch(/2 terminals/);
    });

    it('per WORKSPACE: another workspace still opens; one that ended frees its place', () => {
        const pty = fakePty();
        const host = new TerminalHost(pty.port, limits(1));
        host.open({ workspaceId: 'example', cwd: '/w' });
        expect(() => host.open({ workspaceId: 'example-other', cwd: '/o' })).not.toThrow();
        pty.exit('pty_1');
        expect(host.refusal('example')).toBeNull();
        expect(() => host.open({ workspaceId: 'example', cwd: '/w' })).not.toThrow();
    });

    it("CONTROL: Genie's own system terminals (Take Over, a login) are not the workspace's shells and are never refused", () => {
        const pty = fakePty();
        const host = new TerminalHost(pty.port, limits(1));
        host.open({ workspaceId: 'example', cwd: '/w' });
        expect(() => host.open({ workspaceId: 'example', cwd: '/w', limited: false })).not.toThrow();
        expect(pty.live.size).toBe(2);
    });
});

describe('background processes: refused at the workspace limit', () => {
    const docker: DockerRunner = async () => ({ stdout: '', exitCode: 1 });
    let dir: string;
    let services: ComposedServices;
    let book: ProcessBook;
    let limit = 2;
    const ws = (id: string) => join(dir, id);
    const keep = (workspaceId: string, name: string) => book.create({ workspaceId, workspacePath: ws(workspaceId), name, command: 'php artisan queue:work', restart: 'on-failure' });

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-shell-limits-'));
        for (const w of ['example', 'example-other']) await mkdir(ws(w), { recursive: true });
        services = await composeServices({ userData: dir, pty: fakePty().port, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker, portFree: async () => true });
        limit = 2;
        book = await ProcessBook.open(dir, { supervisor: services.supervisor, envFor: () => ({}), asleep: () => false, limit: () => limit });
    });
    afterEach(async () => {
        await services.shutdown();
        await rm(dir, { recursive: true, force: true });
    });

    it('the one past the limit is REFUSED, names what is running, and is NOT kept (COUNTED)', async () => {
        await keep('example', 'queue');
        await keep('example', 'watcher');
        await expect(keep('example', 'scheduler')).rejects.toThrow(/2 background processes[\s\S]*queue, watcher/);
        expect(book.list('example').map((p) => p.name).sort()).toEqual(['queue', 'watcher']);
        // The agent's `add` asks `prepare` before it asks the person: refused there too, so nobody is asked for nothing.
        expect(() => book.prepare({ workspaceId: 'example', workspacePath: ws('example'), name: 'scheduler', command: 'x', restart: 'never' })).toThrow(/2 background processes/);
    });

    it('per WORKSPACE, and a stopped one frees its place', async () => {
        await keep('example', 'queue');
        const watcher = await keep('example', 'watcher');
        await expect(keep('example-other', 'queue')).resolves.toBeDefined();
        await book.stop(watcher.id);
        await expect(keep('example', 'scheduler')).resolves.toBeDefined();
        // Starting the stopped one again is now past the limit.
        await expect(book.start(watcher.id)).rejects.toThrow(/2 background processes/);
    });

    it('at launch, kept processes past the limit are HELD BACK with the reason, not started', async () => {
        limit = 8;
        await keep('example', 'a');
        await keep('example', 'b');
        await keep('example', 'c');
        await services.shutdown();
        services = await composeServices({ userData: dir, pty: fakePty().port, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker, portFree: async () => true });
        limit = 2;
        book = await ProcessBook.open(dir, { supervisor: services.supervisor, envFor: () => ({}), asleep: () => false, limit: () => limit });
        const { started, heldBack } = book.restore();
        expect(started).toHaveLength(2);
        expect(heldBack).toHaveLength(1);
        const held = book.list('example').find((p) => p.state === 'stopped');
        expect(held?.reason).toMatch(/2 background processes/);
    });
});

describe('a refused terminal, told to the person', () => {
    it("the refusal's own words, without Electron's IPC wrapping", async () => {
        const { refusalText } = await import('../src/core/shell-limits.js');
        expect(refusalText(new Error("Error invoking remote method 'genie:terminal-open': Error: example allows 2 terminals and 2 are running: bash (pid 1), bash (pid 2). Close one, or raise it in the workspace's Settings."))).toBe("example allows 2 terminals and 2 are running: bash (pid 1), bash (pid 2). Close one, or raise it in the workspace's Settings.");
        expect(refusalText(new Error('plain'))).toBe('plain');
        expect(refusalText('text')).toBe('text');
    });
});

describe("the limits in the workspace's Settings", () => {
    it('each limit is a row of the workspace Settings page, a Fancy Select over its numbers, the override marked', async () => {
        const { renderToStaticMarkup } = await import('react-dom/server');
        const { createElement } = await import('react');
        const { Workspace } = await import('../src/renderer/components/Workspace.js');
        const { NO_TERMINALS } = await import('../src/renderer/bridge.js');
        const ops = { asleep: false, agentCount: 0, lastOutcome: null, removePreview: false, onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
            settings: { values: { limit_terminals: '4' }, overridden: ['limit_terminals'], onSet: () => {}, onReset: () => {} } };
        const html = renderToStaticMarkup(createElement(Workspace, { view: 'settings', workspace: { id: 'example', name: 'Example', path: '/w/example' }, terminals: NO_TERMINALS, ops } as never));
        for (const key of Object.values(LIMIT_KEYS)) expect(html, key).toContain(`data-ws-setting="${key}"`);
        expect(html).toContain('data-ws-overridden="limit_terminals"');
        expect(html).not.toContain('data-ws-overridden="limit_processes"');
    });
});
