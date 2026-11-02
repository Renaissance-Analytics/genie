import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * PER-VIEW SUBSCRIPTIONS, HELD BY THE SOURCE (the host split, P2.2: plan §11b). The hub's own tests prove the rule;
 * these hold the wiring to it, so a view cannot quietly go back to a watcher nobody stops or a git run per view.
 */

const read = (path: string) => readFileSync(path, 'utf8');
// Comments are prose, and prose names the old calls; only code is held (stripped line by line).
const code = (path: string) => read(path).split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('the window', () => {
    it('the files host watches nothing itself: no fs.watch in it (the hub owns the watcher)', () => {
        expect(code('src/main/files-host.ts')).not.toMatch(/\bwatch\b[^;]*from 'node:fs'/);
        expect(code('src/main/files-host.ts')).not.toMatch(/\bwatch\(/);
    });

    it('main subscribes and unsubscribes per view, and drops a closed window\'s views', () => {
        const main = code('src/main/main.ts');
        expect(main).toMatch(/ipcMain\.handle\('genie:files-watch'/);
        expect(main).toMatch(/ipcMain\.handle\('genie:files-unwatch'/);
        expect(main).not.toMatch(/filesHost\?\.watch\(/);
        expect(main).toMatch(/dropFilesViewsOf\(/);
    });

    it('the preload\'s subscription unwatches when the view lets go', () => {
        const preload = code('src/main/preload.ts');
        expect(preload).toMatch(/subscribe:\s*\(workspaceId, want, listener\)/);
        expect(preload).toMatch(/'genie:files-unwatch'/);
    });
});

describe('the renderer: every view holds a subscription; git comes pushed', () => {
    const views = ['src/renderer/components/FilesPanelContainer.tsx', 'src/renderer/components/RepoChangesPanel.tsx', 'src/renderer/components/ArtBoardPanel.tsx', 'src/renderer/components/AgentView.tsx'];

    it('no view calls files.watch any more (a watch nobody unwatched)', () => {
        for (const v of views) expect(code(v), v).not.toMatch(/files\.watch\(/);
    });

    it('each view subscribes (the Agent view too: it only listened before, so it depended on another view\'s watcher)', () => {
        for (const v of views) expect(code(v), v).toMatch(/files\.subscribe\??\.?\(/);
    });

    it('the tree and the Repository panel ask for git in their subscription instead of running it per batch', () => {
        expect(code('src/renderer/components/FilesPanelContainer.tsx')).toMatch(/files\.subscribe\??\.?\([^)]*\{\s*git:/);
        expect(code('src/renderer/components/RepoChangesPanel.tsx')).toMatch(/files\.subscribe\??\.?\([^)]*\{\s*repos:/);
    });
});
