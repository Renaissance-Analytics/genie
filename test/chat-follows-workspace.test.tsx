import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { carryChat, parseRoute } from '../src/core/route.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { Shell } from '../src/renderer/Shell.js';
import { EMPTY_SNAPSHOT, NO_FILES, type GenieSnapshot } from '../src/renderer/bridge.js';

/**
 * THE CHAT NEVER QUIETLY KEEPS ANOTHER WORKSPACE'S AGENT (the owner, beta.26: "I sent a chat to the wrong agent because
 * the navigation still doesn't sync — I navigated to the prism workspace but the chat stayed on moic").
 *
 * #258 made an open chat ride every navigation so the person can roam with one conversation open. That still holds
 * inside a workspace and on the surfaces that belong to none (the Dashboard, the Deck, Settings). Arriving at ANOTHER
 * workspace — its own route, or one of its agents — moves the chat to an agent of that workspace: the agent on screen,
 * else the one you last chatted with there, else its first. A workspace with no agent to message says so, and there is
 * nothing to type into. A chat deliberately pointed at another workspace's agent (its tab) names that workspace in the
 * composer, so it is never mistaken for the workspace on screen.
 */
function row(over: Partial<AgentRow>): AgentRow {
    return { id: 'x', name: 'x', provider: 'claude', workspaceId: 'ws_alpha', fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over };
}
// alpha: atlas, wren. beta: lark, rook. empty: nobody. genie: the OS agent, in no project.
const agents: AgentRow[] = [
    row({ id: 'a_atlas', name: 'atlas' }),
    row({ id: 'a_wren', name: 'wren' }),
    row({ id: 'a_lark', name: 'lark', workspaceId: 'ws_beta' }),
    row({ id: 'a_rook', name: 'rook', workspaceId: 'ws_beta' }),
    row({ id: 'a_genie', name: 'genie', workspaceId: '__genie__' }),
];
const workspaces = [
    { id: 'ws_alpha', path: '/w/alpha', name: 'alpha.example', agentsKnown: true },
    { id: 'ws_beta', path: '/w/beta', name: 'beta.example', agentsKnown: true },
    { id: 'ws_empty', path: '/w/empty', name: 'empty.example', agentsKnown: true },
];
const chatOf = (r: string): string | null => parseRoute(r).chat;

describe('navigating to ANOTHER workspace moves the chat to an agent of that workspace', () => {
    const floatingOnAtlas = parseRoute('genie://agent/a_atlas?tab=stream&chat=a_atlas');
    const pinnedOnAtlas = parseRoute('genie://agent/a_atlas?tab=stream&chat=a_atlas&pin=right');

    it('to the workspace: its first agent, or the one you last chatted with there', () => {
        expect(chatOf(carryChat('genie://workspace/ws_beta', floatingOnAtlas, agents, []))).toBe('a_lark');
        expect(chatOf(carryChat('genie://workspace/ws_beta', floatingOnAtlas, agents, ['a_wren', 'a_rook', 'a_lark']))).toBe('a_rook');
    });

    it('to one of its agents: that agent', () => {
        expect(chatOf(carryChat('genie://agent/a_rook?tab=stream', floatingOnAtlas, agents, ['a_lark']))).toBe('a_rook');
    });

    it('a pinned chat moves and stays pinned; a floating one moves and stays floating', () => {
        expect(carryChat('genie://workspace/ws_beta', pinnedOnAtlas, agents, [])).toBe('genie://workspace/ws_beta?chat=a_lark&pin=right');
        expect(carryChat('genie://workspace/ws_beta', floatingOnAtlas, agents, [])).toBe('genie://workspace/ws_beta?chat=a_lark');
    });

    it('CONTROL (#258): inside its own workspace, and on surfaces of no workspace, the chat stays on its agent', () => {
        expect(chatOf(carryChat('genie://agent/a_wren?tab=stream', floatingOnAtlas, agents, []))).toBe('a_atlas');
        expect(chatOf(carryChat('genie://workspace/ws_alpha', floatingOnAtlas, agents, []))).toBe('a_atlas');
        expect(chatOf(carryChat('genie://deck', floatingOnAtlas, agents, []))).toBe('a_atlas');
        expect(chatOf(carryChat('genie://dashboard?group=workspace', floatingOnAtlas, agents, []))).toBe('a_atlas');
    });

    it('CONTROL: genie, the OS agent, belongs to no project and is never swapped out', () => {
        expect(chatOf(carryChat('genie://workspace/ws_beta', parseRoute('genie://deck?chat=genie'), agents, []))).toBe('genie');
        expect(chatOf(carryChat('genie://workspace/ws_beta', parseRoute('genie://deck?chat=a_genie'), agents, []))).toBe('a_genie');
    });

    it('a chat named by its agent’s NAME (a link’s `chat=atlas`) is recognised and moved too', () => {
        expect(chatOf(carryChat('genie://workspace/ws_beta', parseRoute('genie://deck?chat=atlas'), agents, []))).toBe('a_lark');
    });

    it('a route that names its own chat is still left alone', () => {
        expect(carryChat('genie://workspace/ws_beta?chat=a_atlas', floatingOnAtlas, agents, [])).toBe('genie://workspace/ws_beta?chat=a_atlas');
    });
});

describe('the composer on screen', () => {
    const snapshot: GenieSnapshot = { ...EMPTY_SNAPSHOT, agents, workspaces };
    const lark = { agentId: 'a_lark', name: 'lark', fidelity: 'declared' as const, unread: null, messages: [] };
    function render(route: string): string {
        return renderToStaticMarkup(
            <Shell
                route={route}
                snapshot={snapshot}
                servable={['dashboard', 'deck', 'agent', 'workspace']}
                agentDetail={null}
                agentResolved={false}
                selectedRowId={null}
                chatThread={lark}
                pinned={null}
                files={NO_FILES}
                onNavigate={() => {}}
                onOpenAgent={() => {}}
                onAddAgent={() => {}}
                onAddWorkspace={() => {}}
                onOpenPalette={() => {}}
                onSelectRow={() => {}}
                onSend={() => {}}
                onToggleFilesPin={() => {}}
                onCloseChat={() => {}}
                answeringApproval={null}
                onAnswerApproval={() => {}}
                onAnswerDeckItem={() => {}}
            />,
        );
    }
    const count = (html: string, needle: string): number => html.split(needle).length - 1;

    it('on a workspace with NO agent: says so, and there is nothing to type into (control: the same chat on its own workspace has one composer)', () => {
        const empty = render('genie://workspace/ws_empty?chat=a_lark');
        expect(count(empty, 'data-chat-blocked=""')).toBe(1);
        expect(empty).toContain('empty.example has no agent to message. lark is in beta.example.');
        expect(count(empty, 'placeholder="Message lark')).toBe(0);
        const home = render('genie://workspace/ws_beta?chat=a_lark');
        expect(count(home, 'data-chat-blocked=""')).toBe(0);
        expect(count(home, 'placeholder="Message lark"')).toBe(1);
    });

    it('a chat on ANOTHER workspace’s agent names that workspace, in the composer and the header', () => {
        const away = render('genie://workspace/ws_alpha?chat=a_lark');
        expect(count(away, 'placeholder="Message lark — in beta.example"')).toBe(1);
        expect(count(away, 'data-chat-scope="elsewhere"')).toBe(1);
        expect(count(away, 'data-chat-blocked=""')).toBe(0);
        // …and the agent route of the other workspace says the same thing.
        expect(count(render('genie://agent/a_atlas?tab=stream&chat=a_lark'), 'placeholder="Message lark — in beta.example"')).toBe(1);
    });

    it('CONTROL: on its own workspace, its own agent, or a surface of no workspace, the composer is the plain one', () => {
        for (const route of ['genie://workspace/ws_beta?chat=a_lark', 'genie://agent/a_rook?tab=stream&chat=a_lark', 'genie://deck?chat=a_lark']) {
            const html = render(route);
            expect(count(html, 'placeholder="Message lark"')).toBe(1);
            expect(count(html, 'data-chat-scope=')).toBe(0);
        }
    });
});
