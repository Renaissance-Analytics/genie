import { describe, expect, it } from 'vitest';
import {
    mountedFilePanels,
    openFileInPanel,
    PENDING_MS,
    registerFilePanel,
    type OpenFilePorts,
    type PanelOpenRequest,
} from '../file-panel-open';

/**
 * OPENING A FILE BY PATH — the channel that was missing.
 *
 * `CodePanel.selectFile` is private to the component and `on.editorOpenFile` is INBOUND from
 * the MCP tool, so the Agent view's Files and Changes tabs could open the panel and not the
 * file. `master.tsx` says so in a comment: *"Taking you to the panel is a true step toward the
 * file; claiming to open it would not be."* This is the channel that makes the claim true.
 *
 * Three routes, because the panel can be in three places, and every one of them is a place
 * Genie already keeps panels:
 *
 *  1. MOUNTED in this window — the `onOpenInPanel` bus `editor-open.ts` already built.
 *  2. In ANOTHER window (popped out, or a second master) — `FilePanelWindows.routeOpenFile`,
 *     which already focuses that window and queues until it is ready.
 *  3. NOT OPEN YET — queued here until a panel for that workspace mounts, which is what the
 *     caller's own "open the panel" step causes. Same shape as main's `pending` queue.
 *
 * What every test below is really about: a request is only reported as LANDED when something
 * accepted it. A channel that returns success for a file nobody opened is worse than no
 * channel, because the caller stops looking.
 */

const req = (over: Partial<PanelOpenRequest> = {}): PanelOpenRequest => ({
    workspaceId: 'w',
    root: 'C:/ws',
    relPath: 'main/ipc.ts',
    ...over,
});

/** Ports that refuse everything — the "nothing accepted it" baseline. */
function ports(over: Partial<OpenFilePorts> = {}): OpenFilePorts {
    return {
        route: async () => false,
        ...over,
    };
}

describe('the open-by-path channel · a mounted panel', () => {
    it('delivers to the panel mounted for that workspace, and says which one', async () => {
        const delivered: Array<[string, number | undefined]> = [];
        const off = registerFilePanel({
            specId: 'ws-files',
            workspaceId: 'live',
            deliver: async (relPath, line) => { delivered.push([relPath, line]); return true; },
        });
        expect(mountedFilePanels('live')).toEqual(['ws-files']);

        const landing = await openFileInPanel(
            req({ workspaceId: 'live', relPath: 'a/b.ts', line: 42 }),
            ports({
                route: async () => {
                    throw new Error('must not route to another window while one is mounted here');
                },
            }),
        );
        expect(landing).toEqual({ kind: 'live', specId: 'ws-files' });
        expect(delivered).toEqual([['a/b.ts', 42]]);

        // Unmounting really unregisters: a stale entry would send the next request to a panel
        // that is not there and report it landed.
        off();
        expect(mountedFilePanels('live')).toEqual([]);
    });

    it('does NOT report a landing for a panel that refused the file', async () => {
        // `onOpenInPanel` resolves FALSE when the open failed — a vanished file, an unreadable
        // one. The panel shows its own error; what must not happen is this channel telling the
        // caller the file is on screen.
        const off = registerFilePanel({
            specId: 'refuser',
            workspaceId: 'refused',
            deliver: async () => false,
        });
        const routed: PanelOpenRequest[] = [];
        const landing = await openFileInPanel(
            req({ workspaceId: 'refused' }),
            ports({ route: async (request) => { routed.push(request); return true; } }),
        );
        expect(landing.kind).toBe('routed');
        expect(routed).toHaveLength(1);
        off();

        // POSITIVE CONTROL: the same workspace with a panel that ACCEPTS lands live, so the
        // fall-through above is the refusal and not a registry that never matches.
        const accepting = registerFilePanel({
            specId: 'accepter',
            workspaceId: 'refused',
            deliver: async () => true,
        });
        expect((await openFileInPanel(req({ workspaceId: 'refused' }), ports())).kind).toBe('live');
        accepting();
    });
});

describe('the open-by-path channel · a panel in another window', () => {
    it('routes through main when no panel is mounted here', async () => {
        const routed: PanelOpenRequest[] = [];
        const landing = await openFileInPanel(
            req({ workspaceId: 'elsewhere', relPath: 'x.ts', line: 7 }),
            ports({ route: async (request) => { routed.push(request); return true; } }),
        );
        expect(landing).toEqual({ kind: 'routed', specId: null });
        // The whole request goes, ROOT INCLUDED. Main's router hands it to whichever window
        // owns the panel, and a master window resolves the tab against `root` — an empty root
        // there silently re-opens the file as a System panel somewhere else.
        expect(routed).toEqual([{ workspaceId: 'elsewhere', root: 'C:/ws', relPath: 'x.ts', line: 7 }]);
    });
});

describe('the open-by-path channel · no panel open yet', () => {
    it('queues the request and delivers it when a panel for that workspace mounts', async () => {
        const landing = await openFileInPanel(
            req({ workspaceId: 'cold', relPath: 'late.ts', line: 3 }),
            ports(),
        );
        // Not "live", and not "failed" either: the caller's next step is to open the panel,
        // and this is the request waiting for it.
        expect(landing).toEqual({ kind: 'queued', specId: null });

        // A panel for ANOTHER workspace mounting must not pick it up — POSITIVE CONTROL for
        // the match being by workspace and not "the next panel to appear".
        const wrong: string[] = [];
        const offWrong = registerFilePanel({
            specId: 'other-files',
            workspaceId: 'not-cold',
            deliver: async (relPath) => { wrong.push(relPath); return true; },
        });
        expect(wrong).toEqual([]);
        offWrong();

        const opened: Array<[string, number | undefined]> = [];
        const off = registerFilePanel({
            specId: 'cold-files',
            workspaceId: 'cold',
            deliver: async (relPath, line) => { opened.push([relPath, line]); return true; },
        });
        expect(opened).toEqual([['late.ts', 3]]);
        off();
    });

    it('delivers a queued request ONCE — a second panel mounting does not reopen it', async () => {
        await openFileInPanel(req({ workspaceId: 'once', relPath: 'one.ts' }), ports());
        const opened: string[] = [];
        const deliver = async (relPath: string) => { opened.push(relPath); return true; };
        const first = registerFilePanel({ specId: 'a', workspaceId: 'once', deliver });
        const second = registerFilePanel({ specId: 'b', workspaceId: 'once', deliver });
        expect(opened).toEqual(['one.ts']);
        first();
        second();
    });

    it('keeps the NEWEST request when two are queued for one workspace', async () => {
        await openFileInPanel(req({ workspaceId: 'newest', relPath: 'first.ts' }), ports());
        await openFileInPanel(req({ workspaceId: 'newest', relPath: 'second.ts' }), ports());
        const opened: string[] = [];
        const off = registerFilePanel({
            specId: 'n',
            workspaceId: 'newest',
            deliver: async (relPath) => { opened.push(relPath); return true; },
        });
        // One click, one file. Opening both would resurrect a tab the user moved on from.
        expect(opened).toEqual(['second.ts']);
        off();
    });

    it('FORGETS a request the user made too long ago', async () => {
        // A panel can mount hours later (the workspace was never opened). Opening a file
        // somebody asked for before lunch is a surprise, not a service.
        let clock = 1_000;
        await openFileInPanel(req({ workspaceId: 'stale', relPath: 'old.ts' }), ports({ now: () => clock }));
        clock += PENDING_MS + 1;
        const opened: string[] = [];
        const off = registerFilePanel({
            specId: 's',
            workspaceId: 'stale',
            now: () => clock,
            deliver: async (relPath) => { opened.push(relPath); return true; },
        });
        expect(opened).toEqual([]);
        off();

        // POSITIVE CONTROL: the identical sequence one millisecond INSIDE the window delivers,
        // so the silence above is the expiry and not a flush that never fires.
        let fresh = 1_000;
        await openFileInPanel(req({ workspaceId: 'fresh', relPath: 'new.ts' }), ports({ now: () => fresh }));
        fresh += PENDING_MS - 1;
        const inTime: string[] = [];
        const offFresh = registerFilePanel({
            specId: 'f',
            workspaceId: 'fresh',
            now: () => fresh,
            deliver: async (relPath) => { inTime.push(relPath); return true; },
        });
        expect(inTime).toEqual(['new.ts']);
        offFresh();
    });
});
