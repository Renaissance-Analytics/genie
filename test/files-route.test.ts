import { describe, expect, it } from 'vitest';
import { routeFileToOpen } from '../src/core/files-panel.js';
import { formatRoute, parseRoute } from '../src/core/route.js';
import { trayOf } from '../src/core/row-tray.js';
import type { AgentRow } from '../src/core/dashboard-view.js';

/**
 * THE FILE PANEL IN THE URL, IN THE BOARD'S KEYS (`Workspace Files`: `?files=ChallengeStore.php&filter=changed`,
 * `?files=detached`). The open file and the Changed filter were not in the route at all (only `?panel=files`), so a
 * link could not point at a file and refresh lost it. The board's keys replace ours; `?panel=files` still parses, so
 * an old link opens the panel.
 */
describe('the route', () => {
    it('an open file and the filter', () => {
        const r = parseRoute('genie://workspace/tynn?files=src%2FChallengeStore.php&filter=changed');
        expect(r).toMatchObject({ surface: 'workspace', workspaceId: 'tynn', panel: 'files', file: 'src/ChallengeStore.php', filter: 'changed', detached: false });
        expect(formatRoute(r)).toBe('genie://workspace/tynn?files=src%2FChallengeStore.php&filter=changed');
    });

    it('the panel open with no file, detached, closed — and an old ?panel=files link still opens it', () => {
        expect(parseRoute('genie://workspace/tynn?files=')).toMatchObject({ panel: 'files', file: null, detached: false, filter: null });
        expect(parseRoute('genie://workspace/tynn?files=detached')).toMatchObject({ panel: 'files', file: null, detached: true });
        expect(formatRoute(parseRoute('genie://workspace/tynn?files=detached'))).toBe('genie://workspace/tynn?files=detached');
        expect(parseRoute('genie://workspace/tynn')).toMatchObject({ panel: null, file: null, detached: false, filter: null });
        const old = parseRoute('genie://workspace/tynn?panel=files');
        expect(old).toMatchObject({ panel: 'files', file: null });
        expect(formatRoute(old)).toBe('genie://workspace/tynn?files=');
    });
});

describe('the row tray\'s Files door uses the board\'s key', () => {
    it('opens the workspace with its file panel', () => {
        const row = { id: 'kai', name: 'kai', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null } as AgentRow;
        expect(trayOf(row).doors.find((d) => d.door === 'files')!.route).toBe('genie://workspace/tynn?files=');
    });
});

describe('routeFileToOpen: the route opens a file, the panel never fights it', () => {
    it('opens the route\'s file when it is not the one open; nothing when it is, or when the route names none', () => {
        expect(routeFileToOpen('src/a.ts', null)).toBe('src/a.ts');
        expect(routeFileToOpen('src/a.ts', 'src/b.ts')).toBe('src/a.ts');
        expect(routeFileToOpen('src/a.ts', 'src/a.ts')).toBeNull();
        expect(routeFileToOpen(null, 'src/b.ts')).toBeNull();
    });
});
