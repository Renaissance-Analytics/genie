import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentDriverPanel } from '../Master/AgentManager';
import type { AgentManagerState } from '../../lib/genie';

/**
 * THE DRIVER PANEL — genie#463 and #474, rendered.
 *
 * Two verbs an agent had over MCP and a human did not have anywhere:
 * `runAgent switchTui` (drivers) and `runAgent stop` (the run). This is the
 * surface that gives a person both, and the assertions that matter are the ones
 * about what it does NOT offer — a switch the host would refuse, and a stop
 * dressed up as a delete.
 *
 * Rendered through `react-dom/server` because the renderer test env has no DOM.
 * The server renderer still runs every component function and throws where the
 * browser would, which is the class of fault an error boundary catches.
 */

const drivers = [
    { tui: 'claude', label: 'Claude Code' },
    { tui: 'codex', label: 'Codex' },
    { tui: 'genie', label: 'Genie' },
];

type Agent = NonNullable<AgentManagerState['agent']>;

const agent = (over: Partial<Agent> = {}): Agent =>
    ({
        id: 'a1',
        workspaceId: 'ws',
        name: 'moic',
        purpose: 'agent management',
        avatar: null,
        role: 'specialized',
        tui: 'claude',
        running: true,
        isSidecar: false,
        terminalSpecId: 't-claude',
        allowedTuis: [],
        runtimes: [{ id: 'r1', tui: 'claude', terminalSpecId: 't-claude', fronted: true }],
        ...over,
    }) as Agent;

function render(over: Partial<Agent> = {}, avatar = ''): string {
    return renderToStaticMarkup(
        React.createElement(AgentDriverPanel, {
            agent: agent(over),
            drivers,
            busy: false,
            avatar,
            avatarError: null,
            onAvatarChange: () => {},
            onSwitch: () => {},
            onRun: () => {},
        }),
    );
}

describe('the driver panel', () => {
    it('names the driver the agent is actually running under', () => {
        expect(render()).toContain('moic is running under Claude Code.');
    });

    it('offers a switch for every driver except the one in the chair', () => {
        const html = render();
        expect(html).toContain('driver-switch-codex');
        expect(html).toContain('driver-switch-genie');
        // POSITIVE CONTROL for the two above: the active driver is listed, and
        // simply has no button — a "Switch to Claude Code" whose success
        // changes nothing is worse than no control.
        expect(html).toContain('driver-row-claude');
        expect(html).not.toContain('driver-switch-claude');
    });

    it('says which drivers hold a parked conversation, and which were never run', () => {
        const html = render({
            runtimes: [
                { id: 'r1', tui: 'claude', terminalSpecId: 't-claude', fronted: true },
                { id: 'r2', tui: 'codex', terminalSpecId: 't-codex', fronted: false },
            ],
        });
        expect(html).toContain('sidecar');
        expect(html).toMatch(/Never run|not added|Not run/i);
    });

    /**
     * The refusal `decideTuiSwitch` makes on the host, made HERE too — so the
     * button whose only possible outcome is that error is never drawn.
     */
    it('does not offer a driver the agent’s AGENT.md excludes, and says why', () => {
        const html = render({ allowedTuis: ['claude', 'codex'] });
        expect(html).not.toContain('driver-switch-genie');
        expect(html).toContain('driver-refusal-genie');
        expect(html).toContain('claude, codex');
        // POSITIVE CONTROL: without this, a panel that rendered no switches at
        // all would pass. A permitted driver is still offered in the SAME render.
        expect(html).toContain('driver-switch-codex');
    });

    it('treats an empty tuis list as no opinion — every driver stays offered', () => {
        const html = render({ allowedTuis: [] });
        expect(html).toContain('driver-switch-codex');
        expect(html).toContain('driver-switch-genie');
        expect(html).not.toContain('driver-refusal-');
    });
});

describe('the run control on the driver panel (genie#474)', () => {
    it('offers STOP for a running agent and says what it keeps', () => {
        const html = render({ running: true });
        expect(html).toContain('driver-run-stop');
        expect(html).toContain('Stop moic');
        expect(html).toMatch(/keeps its identity/i);
        expect(html).toContain('AGENT.md');
        expect(html).not.toContain('driver-run-start');
    });

    it('POSITIVE CONTROL: a dormant agent is offered START instead', () => {
        const html = render({ running: false, terminalSpecId: null });
        expect(html).toContain('driver-run-start');
        expect(html).toContain('Start moic');
        expect(html).not.toContain('driver-run-stop');
    });

    /** The whole reason the issue was filed: the two verbs must not be confused. */
    it('never offers Delete — this panel cannot remove an agent', () => {
        const html = `${render({ running: true })}${render({ running: false })}`;
        expect(html).not.toMatch(/Delete/i);
        expect(html).not.toMatch(/Unmount/i);
    });
});

describe('the agent’s own mark', () => {
    it('is editable here, beside the driver whose logo it replaces', () => {
        const html = render({}, '🦊');
        expect(html).toContain('driver-avatar');
        // POSITIVE CONTROL for the refusal below: nothing is flagged when
        // nothing was refused.
        expect(html).not.toContain('driver-avatar-error');
    });

    it('shows a rejected mark’s reason rather than dropping it silently', () => {
        const html = renderToStaticMarkup(
            React.createElement(AgentDriverPanel, {
                agent: agent(),
                drivers,
                busy: false,
                avatar: 'ab',
                avatarError: 'One glyph, please.',
                onAvatarChange: () => {},
                onSwitch: () => {},
                onRun: () => {},
            }),
        );
        expect(html).toContain('driver-avatar-error');
        expect(html).toContain('One glyph, please.');
    });
});
