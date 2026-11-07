import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';

const row: AgentRow = { id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'release-beta34', fidelity: 'declared', state: 'idle', duration: null,
    ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null };
const html = () => renderToStaticMarkup(<Dashboard rows={[row]} workspaces={[{ id: 'release-beta34', name: 'release-beta34', path: 'C:/Users/genie/work/a-long-workspace-folder-name/release-beta34' }]} onOpenAgent={() => {}} onAddAgent={() => {}} onOpenWorkspace={() => {}} />);
describe('the flat Dashboard headers and workspace column hold one line', () => {
    it('has seven truncated column labels in one fixed-height header, with no grouping headers', () => {
        const markup = html();
        const header = /<div class="grid[^>]* h-7[^>]*>([\s\S]*?)<\/div>/.exec(markup);
        expect(header).not.toBeNull();
        expect([...header![1]!.matchAll(/<span class="truncate">([^<]+)<\/span>/g)].map((match) => match[1])).toEqual(['Agent', 'Workspace', 'Status', 'Current target', 'Latest delivery', 'Comms', 'Context']);
        expect(markup).not.toContain('data-workspace-head'); expect(markup).not.toContain('data-status-group');
    });
    it('lets a long workspace label truncate while retaining its full tooltip', () => {
        const markup = html();
        expect(markup).toMatch(/data-column="workspace"[^>]*class="[^"]*min-w-0/);
        expect(markup).toContain('title="release-beta34"');
        expect(markup).toMatch(/data-open-workspace="release-beta34"[^>]*class="[^"]*min-w-0|class="[^"]*min-w-0[^>]*data-open-workspace="release-beta34"/);
    });
});
