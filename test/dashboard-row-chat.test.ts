import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chatSubjectFor } from '../src/core/chat-scope.js';
import { parseRoute } from '../src/core/route.js';

/**
 * ON THE DASHBOARD, A CLICKED AGENT'S CHAT OPENS AND THE DASHBOARD STAYS (genie#1209; the owner, 2026-10-26: "on the
 * dashboard page I should be able to click on agent to bring up their chat and stay on the dashboard"). The chat is
 * always docked beside the page; on the Dashboard its subject was always genie, and a row click LEFT for the agent's
 * page. Now the agent picked on the Dashboard is the chat's subject while the Dashboard is on screen — kept by the
 * window, not the address (a `chat=` in a route is still not read, Tynn #831). The row tray's "Open agent" still opens
 * its page.
 */

const agents = [
    { id: 'a_atlas', name: 'atlas', workspaceId: 'ws' },
    { id: 'a_wren', name: 'wren', workspaceId: 'ws' },
    { id: 'a_genie', name: 'genie', workspaceId: '__genie__' },
];
const workspaces = [{ id: 'ws', defaultAgentId: 'a_wren' }];

describe('the chat’s subject on the Dashboard', () => {
    it('is the agent picked there (CONTROL: none picked → genie, as before)', () => {
        expect(chatSubjectFor(parseRoute('genie://dashboard'), agents, workspaces, 'a_atlas')).toBe('a_atlas');
        expect(chatSubjectFor(parseRoute('genie://dashboard'), agents, workspaces, null)).toBe('a_genie');
    });

    it('a pick is the Dashboard’s only: on a workspace or an agent page the view decides, as before', () => {
        expect(chatSubjectFor(parseRoute('genie://workspace/ws'), agents, workspaces, 'a_atlas')).toBe('a_wren');
        expect(chatSubjectFor(parseRoute('genie://agent/a_wren?tab=stream'), agents, workspaces, 'a_atlas')).toBe('a_wren');
    });

    it('a picked agent no longer on the roster is not the subject (deleted meanwhile): genie', () => {
        expect(chatSubjectFor(parseRoute('genie://dashboard'), agents, workspaces, 'a_gone')).toBe('a_genie');
    });
});

describe('the wiring (comment LINES dropped — a // inside a string such as genie://deck stays)', () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');

    it('the Dashboard’s row click picks the chat — it no longer navigates to the agent; a waiting row still opens its Deck item', () => {
        const shell = source('../src/renderer/Shell.tsx');
        const block = shell.slice(shell.indexOf('<Dashboard'), shell.indexOf('/>', shell.indexOf('onChat={', shell.indexOf('<Dashboard'))));
        const handler = block.slice(block.indexOf('onOpenAgent={(id) => {'), block.indexOf('onOpenAgent={(id) => {') + 400);
        expect(handler).toMatch(/deckItemFor\(id,[\s\S]*genie:\/\/deck\?item=[\s\S]*else onChatAgent\(id\);/);
        expect(handler).not.toMatch(/else onOpenAgent\(id\);/);
    });

    it('App passes the picked agent to the chat’s subject, and forgets it once the Dashboard is left', () => {
        const app = source('../src/renderer/App.tsx');
        expect(app).toMatch(/chatSubjectFor\(parsed, snapshot\.agents, snapshot\.workspaces \?\? \[\], dashboardChat\)/);
        expect(app).toMatch(/if \(parsed\.surface !== 'dashboard'\) setDashboardChat\(null\)/);
    });
});
