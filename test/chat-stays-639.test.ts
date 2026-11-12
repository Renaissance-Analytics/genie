import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as Scope from '../src/core/chat-scope.js';
import { parseRoute } from '../src/core/route.js';

/*
 * TYNN #639 (the owner, 2026-11-12: "let's disable the agent chat switching to genie when I navigate to other pages. It
 * should stay on whatever agent I select either from any of the dashboards or tabs."). The chat is the agent the PERSON
 * last selected — on the Genie Dashboard, on a workspace dashboard (which opens its tab), or by opening an agent's tab —
 * until they select another. Navigating never changes it. Genie's agent only when the person selects it, or has never
 * selected one.
 */
const agents = [
    { id: 'a_atlas', name: 'atlas', workspaceId: 'ws' },
    { id: 'a_wren', name: 'wren', workspaceId: 'ws' },
    { id: 'a_genie', name: 'genie', workspaceId: '__genie__' },
];
type Subject = (route: ReturnType<typeof parseRoute>, roster: typeof agents, pick: string | null) => string;
type PickAfter = (route: ReturnType<typeof parseRoute>, roster: typeof agents, pick: string | null) => string | null;
const subject = Scope.chatSubjectFor as unknown as Subject;
const pickAfter = (Scope as unknown as { chatPickAfter?: PickAfter }).chatPickAfter;

describe('the chat stays on the agent the person selected', () => {
    it('a pick made on the Dashboard survives every page: a workspace, settings, the Deck, files', () => {
        for (const route of ['genie://dashboard', 'genie://workspace/ws', 'genie://settings', 'genie://deck', 'genie://files/ws']) {
            expect(subject(parseRoute(route), agents, 'a_atlas'), route).toBe('a_atlas');
        }
    });

    it("opening an agent's tab selects it, and leaving the tab keeps it", () => {
        expect(pickAfter, 'chatPickAfter').toBeTypeOf('function');
        const opened = pickAfter!(parseRoute('genie://agent/a_wren?tab=stream'), agents, 'a_atlas');
        expect(opened).toBe('a_wren');
        expect(subject(parseRoute('genie://agent/a_wren?tab=stream'), agents, opened)).toBe('a_wren');
        expect(pickAfter!(parseRoute('genie://settings'), agents, opened)).toBe('a_wren');
        expect(subject(parseRoute('genie://settings'), agents, opened)).toBe('a_wren');
        expect(subject(parseRoute('genie://workspace/ws'), agents, opened)).toBe('a_wren');
    });

    it("an agent's tab on screen is that agent's chat, whatever was picked before", () => {
        expect(subject(parseRoute('genie://agent/a_atlas?tab=stream'), agents, 'a_wren')).toBe('a_atlas');
    });

    it('CONTROL: never selected -> Genie, on every page; a picked agent since deleted -> Genie', () => {
        for (const route of ['genie://dashboard', 'genie://workspace/ws', 'genie://settings']) expect(subject(parseRoute(route), agents, null), route).toBe('a_genie');
        expect(subject(parseRoute('genie://workspace/ws'), agents, 'a_gone')).toBe('a_genie');
    });

    it('CONTROL: navigating with no agent tab on screen never changes the pick', () => {
        for (const route of ['genie://dashboard', 'genie://workspace/ws', 'genie://settings']) expect(pickAfter!(parseRoute(route), agents, 'a_atlas'), route).toBe('a_atlas');
        expect(pickAfter!(parseRoute('genie://settings'), agents, null)).toBeNull();
    });
});

describe('the wiring', () => {
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
    it('App keeps ONE pick for the window: the Dashboard click sets it, an agent tab sets it, and nothing clears it on navigation', () => {
        expect(app).toMatch(/chatSubjectFor\(parsed, chatRoster, chatPick\)/);
        expect(app).toMatch(/onChatAgent=\{\(id\) => setChatPick\(id\)\}/);
        expect(app).toMatch(/chatPickAfter\(parsed, chatRoster, /);
        expect(app).not.toMatch(/setDashboardChat\(null\)/);
    });
});
