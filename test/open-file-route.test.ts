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
    it('opens the file in Genie and brings Genie forward — never the OS default app', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        const at = main.indexOf('openFile: async');
        const port = main.slice(at, main.indexOf('\n', main.indexOf('},', at)));
        expect(port).toContain('openFileRoute(');
        expect(port).toContain("broadcast('genie:navigate'");
        expect(port).toContain('revealMainWindow()');
        expect(port).not.toContain('shell.openPath');
    });
});
