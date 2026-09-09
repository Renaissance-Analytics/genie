import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ListsFlyout, { ListsBody, type ListsBodyProps } from '../Master/ListsFlyout';
import type { WorkspaceListsSpec } from '../../lib/genie';

/**
 * What the lists panel actually SAYS — genie#556, genie#586.
 *
 * Three of the four states here are ones a person cannot tell apart from a
 * working empty list unless the panel spells them out, and each has a different
 * next action:
 *
 *   - nothing is waiting on you (fine, do nothing)
 *   - the lists could not be READ at all (find out why — on a remote window the
 *     likeliest cause is a host too old to serve them)
 *   - a nudge did not reach the agent that asked (tell them yourself)
 *
 * All three render as "an empty panel" if nobody writes the sentence, which is
 * why they are pinned as markup rather than left to the container.
 *
 * The renderer test env has no DOM, so this goes through `react-dom/server`:
 * the real component, the real markup, minus the effects.
 */

const EMPTY: WorkspaceListsSpec = { agents: [], user: [], userCount: 0 };

const props = (over: Partial<ListsBodyProps> = {}): ListsBodyProps => ({
    view: EMPTY,
    remote: false,
    error: null,
    busy: null,
    outcome: null,
    onResolve: () => {},
    ...over,
});

const render = (over: Partial<ListsBodyProps> = {}): string =>
    renderToStaticMarkup(React.createElement(ListsBody, props(over)));

describe('the UserList half — what is waiting on a person', () => {
    it('lists each item with the agent that asked for it', () => {
        const html = render({
            view: {
                agents: [],
                user: [
                    { id: 'u1', text: 'Approve the staging login', agentName: 'alpha' },
                    { id: 'u2', text: 'Rotate the deploy key', agentName: 'beta' },
                ],
                userCount: 2,
            },
        });

        expect(html).toContain('Approve the staging login');
        expect(html).toContain('Rotate the deploy key');
        // WHO is waiting is the reason to do it now rather than later.
        expect(html).toContain('alpha');
        expect(html).toContain('beta');
    });

    it('says nothing is waiting, rather than rendering a blank', () => {
        const html = render();
        expect(html).toMatch(/nothing.*waiting|no items|nothing is waiting/i);
    });
});

describe('the AgentList half — what each agent is tracking', () => {
    it('groups items under the agent that owns them', () => {
        // Only the ACTIVE tab's panel is rendered, so this opens on that tab.
        const html = render({
            initialTab: 'agents',
            view: {
                agents: [
                    { agentName: 'alpha', items: [{ id: 'a1', text: 'Read the RFC' }] },
                    { agentName: 'beta', items: [{ id: 'b1', text: 'Write the test' }] },
                ],
                user: [],
                userCount: 0,
            },
        });

        expect(html).toContain('alpha');
        expect(html).toContain('Read the RFC');
        expect(html).toContain('beta');
        expect(html).toContain('Write the test');
    });

    it('says no agent is keeping a list, rather than rendering a blank', () => {
        const html = render({ initialTab: 'agents' });
        expect(html).toMatch(/no agent in this workspace is keeping a list/i);
    });
});

describe('a REMOTE window renders the HOST’s lists (genie#586)', () => {
    /**
     * The lists are HOST-SOURCED now: the bridge reads `/api/desktop/lists/*`,
     * so a host-bound window shows the same rows the owner's own window does.
     * Refusing to render on `remote` — the interim behaviour while there was no
     * passthrough — would now hide a list that was successfully fetched.
     */
    it('shows the items it was given, exactly as a local window does', () => {
        const view: WorkspaceListsSpec = {
            agents: [{ agentName: 'alpha', items: [{ id: 'a1', text: 'Read the RFC' }] }],
            user: [{ id: 'u1', text: 'Approve the staging login', agentName: 'alpha' }],
            userCount: 1,
        };

        const html = render({ remote: true, view });

        expect(html).toContain('Approve the staging login');
        expect(html).not.toMatch(/cannot be read from here|open genie on that machine/i);
    });

    it('says nothing is waiting when the HOST really has nothing waiting', () => {
        const html = render({ remote: true });
        expect(html).toMatch(/nothing.*waiting|no items/i);
    });
});

describe('a panel that could not READ the lists says so, and why', () => {
    /**
     * The one state that must never render as an empty list. A host running an
     * older Genie serves no `/api/desktop/lists/*` at all, and a dropped link
     * fails the same way — both come back as a rejected read, which silently
     * became "you have nothing to do" if the panel just kept its empty view.
     */
    it('names the reason instead of rendering an empty list', () => {
        const html = render({ error: 'HTTP 405' });

        expect(html).toMatch(/HTTP 405/);
        expect(html).not.toMatch(/nothing is waiting on you/i);
    });

    it('tells a REMOTE window an older host may not serve them at all', () => {
        const html = render({ remote: true, error: 'method not allowed' });

        expect(html).toMatch(/method not allowed/);
        expect(html).toMatch(/older/i);
    });

    it('POSITIVE CONTROL: the same empty view with no error says the ordinary thing', () => {
        // Without this, "the failure notice appears" would pass against a panel
        // that shows the notice always.
        const html = render({ error: null });
        expect(html).toMatch(/nothing.*waiting|no items/i);
        expect(html).not.toMatch(/could not read/i);
    });

    /**
     * A resolve and the re-read that follows it travel the same wire, so they
     * fail together — and that is precisely when the person has just ticked
     * something off and is owed an answer about whether the agent heard.
     * Replacing the whole panel with the read failure would throw that answer
     * away at the one moment it is load-bearing.
     */
    it('still reports the nudge outcome when the re-read after it failed', () => {
        const html = render({
            error: 'Remote session expired — re-pair with the host.',
            outcome: {
                delivered: false,
                agentName: 'alpha',
                reason: 'alpha is not running in this workspace, so it was not told.',
            },
        });

        expect(html).toMatch(/not running in this workspace/);
        expect(html).toMatch(/Remote session expired/);
    });
});

describe('the nudge outcome is reported, never assumed', () => {
    const oneItem: WorkspaceListsSpec = {
        agents: [],
        user: [{ id: 'u1', text: 'Approve it', agentName: 'alpha' }],
        userCount: 1,
    };

    it('says the agent was told, and which one', () => {
        const html = render({
            view: oneItem,
            outcome: { delivered: true, agentName: 'alpha' },
        });
        expect(html).toMatch(/alpha/);
        expect(html).toMatch(/told|notified|nudged/i);
    });

    it('says plainly when the agent did NOT hear it, and why', () => {
        // The failure this whole feature exists to prevent: a tick in the UI
        // over a nudge that went nowhere.
        const html = render({
            view: oneItem,
            outcome: {
                delivered: false,
                agentName: 'alpha',
                reason: 'alpha is not running in this workspace, so it was not told.',
            },
        });
        expect(html).toMatch(/not running in this workspace/);
        expect(html).not.toMatch(/notified alpha|alpha was told/i);
    });
});

/**
 * `open` and `pinned` mean different things, and the panel has to honour both.
 *
 * `open` is "the panel is showing"; `pinned` is "when it shows, dock it rather
 * than float it". Folding them together made the header icon a DEAD CONTROL for
 * as long as the panel was docked — it toggled a state nothing rendered, which
 * is the worst kind of broken button because it looks fine.
 */
const shell = (over: { open: boolean; pinned: boolean }): string =>
    renderToStaticMarkup(
        React.createElement(ListsFlyout, {
            workspaceId: 'ws-1',
            onClose: () => {},
            onTogglePin: () => {},
            ...over,
        }),
    );

describe('showing and docking are two different switches', () => {
    it('docks when it is pinned AND showing', () => {
        expect(shell({ open: true, pinned: true })).toContain('lists-dock');
    });

    it('renders NOTHING when pinned but hidden — the icon must still hide it', () => {
        expect(shell({ open: false, pinned: true })).toBe('');
    });

    it('floats over the Floor when it is showing and not pinned', () => {
        const html = shell({ open: true, pinned: false });
        expect(html).toContain('docs-flyout');
        expect(html).not.toContain('lists-dock');
    });

    it('keeps the unpinned flyout mounted but closed, so it can slide in', () => {
        // The flyout animates on `.open`, so unlike the dock it stays in the
        // tree — asserting "" here instead would pin the wrong mechanism.
        const html = shell({ open: false, pinned: false });
        expect(html).toContain('docs-flyout-root');
        expect(html).not.toContain('docs-flyout-root open');
    });
});
