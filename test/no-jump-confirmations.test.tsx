import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { importedAgents } from '../src/core/agent-adoption.js';
import { ShareLinkForm, TynnWorkstationRows } from '../src/renderer/components/ConnectMenu.js';
import { AgentRosterView, ImportedAgentsView } from '../src/renderer/components/ImportedAgents.js';
import { RepoChangesView } from '../src/renderer/components/RepoChangesPanel.js';
import { control } from './helpers/control-markup.js';

/*
 * NO CONFIRMATION LINE IN THE LAYOUT (the owner: "it should be a popover that appears, not a label that makes the ui
 * jump"). A finished action's words are a Flash (react-fancy Popover, portaled; test/flash-no-jump.test.tsx proves it
 * appears and goes). Server markup has no portal, so here the words must be ABSENT from the page itself. A failure keeps
 * its reason and Retry inline: it asks for an action.
 */
const noop = () => {};

describe('a Tynn workstation row', () => {
    const list = { ok: true as const, workstations: [{ id: 'ws_a', name: 'studio', active: true, connectable: true, local: true, source: 'owner' }] };
    const row = (opening: Parameters<typeof TynnWorkstationRows>[0]['opening']) => renderToStaticMarkup(<TynnWorkstationRows list={list} onOpenWorkstation={noop} opening={opening} />);

    it('opened: no line under the row', () => {
        const html = row({ ws_a: { kind: 'done', note: 'Opened in its own window' } });
        expect(html).not.toContain('Opened in its own window');
        expect(html).not.toContain('data-connect-done');
    });

    it('opening: the step is on the Open button (busy), not a line under the row', () => {
        const html = row({ ws_a: { kind: 'working', step: 'Opening its window…' } });
        expect(html).not.toContain('data-connect-step');
        const open = control(html, 'data-action="open-workstation"')!;
        expect(open.open).toMatch(/\sdisabled=""/);
        expect(open.open).toMatch(/\saria-busy="true"/);
    });

    it('CONTROL: a failure keeps its reason and Retry inline', () => {
        const html = row({ ws_a: { kind: 'failed', reason: 'No way in' } });
        expect(html).toContain('No way in');
        expect(html).toContain('data-action="retry-workstation"');
    });
});

describe('the share-link form', () => {
    it('done: its words are not in the form', () => {
        expect(renderToStaticMarkup(<ShareLinkForm value="x" state={{ kind: 'done', note: 'Opened the invite' }} onChange={noop} onOpen={noop} />)).not.toContain('Opened the invite');
    });
});

describe('repo changes', () => {
    it('a commit\'s notice is not a line in the panel', () => {
        const html = renderToStaticMarkup(<RepoChangesView repos={[{ rel: '', name: 'app' }]} repoRel="" status={null} selected={[]} diff={null} busy={false} error={null} notice="Committed" draft={{ message: '' }} on={{}} />);
        expect(html).not.toContain('data-repo-notice');
        expect(html).not.toContain('Committed');
    });
});

describe('adopting and reattaching agents', () => {
    const agents = importedAgents({ files: [{ folder: 'atlas' }], configs: {}, registered: [] });
    it('the adopt notice is not a line on the page', () => {
        const html = renderToStaticMarkup(<ImportedAgentsView workspaceName="Acme" path="/w/acme" agents={agents} busy={null} notice="atlas is registered." error={null} onAdopt={noop} onOpen={noop} />);
        expect(html).not.toContain('atlas is registered.');
        expect(html).not.toContain('data-imported-agents-notice');
    });
    it('the reattach notice is not a line on the page', () => {
        const html = renderToStaticMarkup(<AgentRosterView registered={[]} onDisk={agents} busy={null} notice="atlas is registered." error={null} onReattach={noop} />);
        expect(html).not.toContain('atlas is registered.');
    });
});

describe('Tynn panels (board, home, features, issues)', () => {
    it('OpLine: a finished action is a Flash, never a line', () => {
        for (const f of ['TynnBoardPanel', 'TynnIssuesPanel']) {
            const src = readFileSync(`src/renderer/components/${f}.tsx`, 'utf8');
            expect(src, f).not.toMatch(/data-(tynn|issue)-op="done"/);
            expect(src, f).toMatch(/<Flash\b/);
        }
    });
});

describe('the rest, by source', () => {
    it('the flow editor flashes "Saved", never a bar', () => {
        const src = readFileSync('src/renderer/components/FlowEditorWindow.tsx', 'utf8');
        expect(src).not.toMatch(/'Saved\.'\)/);
        expect(src).toMatch(/<Flash\b/);
    });
    it('IssueWatch: "Saved" is a flash', () => {
        const src = readFileSync('src/renderer/components/AgentView.tsx', 'utf8');
        expect(src).not.toMatch(/save\.phase === 'saved' \? 'Saved'/);
    });
});
