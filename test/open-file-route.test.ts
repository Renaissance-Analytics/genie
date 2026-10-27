import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openFileRoute } from '../src/core/files-panel.js';
import { parseRoute } from '../src/core/route.js';

/**
 * WHERE AN AGENT'S openFileForUser LANDS (genie#922, Tynn #804). The owner, 2026-10-17: it "opened the readme file in a
 * notepad++, why?" — main handed the path to the OS's default app (`shell.openPath`). It opens in Genie: that workspace's
 * own file panel, with the file open.
 */
describe('the route', () => {
    it('is the workspace with its file panel open on that file — read back by the router as exactly that', () => {
        const route = parseRoute(openFileRoute('tynn', 'docs/plan v2.md'));
        expect(route).toMatchObject({ surface: 'workspace', workspaceId: 'tynn', panel: 'files', file: 'docs/plan v2.md' });
    });
});

describe('main', () => {
    it('opens the file in Genie WITHOUT taking focus (genie#1235) or the view (genie#1265) — never the OS default app', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        const at = main.indexOf('openFile: async');
        const port = main.slice(at, main.indexOf('\n', main.indexOf('},', at)));
        // The file waits in its workspace (the row pulses); the person's arrival opens this route (core/view-requests.ts).
        expect(port).toContain("showToPerson({ activation: 'background', workspaceId, file: path, line, reason: 'openFileForUser' })");
        expect(port).not.toContain("broadcast('genie:navigate'");
        // An agent's call: the main window is flashed at most, never shown or focused — the owner's keyboard stays theirs.
        expect(port).toContain("attractMainWindow('openFileForUser')");
        expect(port).not.toContain('revealMainWindow');
        expect(port).not.toContain('shell.openPath');
    });
});
