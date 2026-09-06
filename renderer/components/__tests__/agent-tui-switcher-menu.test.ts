import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TuiSwitcherMenu } from '../Master/AgentTuiSwitcher';
import { driverRows } from '../../lib/agent-manager';

/**
 * The panel-header driver menu — genie#463.
 *
 * This is the quick flip beside a live agent, the manager's Driver tab being the
 * full-size version. Both build their rows from `driverRows`, which is
 * `decideTuiSwitch` — the rule the host applies — so neither can offer a driver
 * the agent's own `AGENT.md` excludes.
 *
 * Rendered through the exported menu BODY rather than the component: a closed
 * `Popover.Content` renders nothing on the server, so a test of the wrapper
 * would assert against a trigger and prove nothing about the menu.
 */

const drivers = [
    { tui: 'claude', label: 'Claude Code' },
    { tui: 'codex', label: 'Codex' },
    { tui: 'genie', label: 'Genie' },
];

function render(input: {
    runtimes?: { id: string; tui: string; terminalSpecId: string | null; fronted: boolean }[];
    allowed?: string[];
    switchError?: string | null;
}): string {
    return renderToStaticMarkup(
        React.createElement(TuiSwitcherMenu, {
            rows: driverRows({
                drivers,
                runtimes: input.runtimes ?? [
                    { id: 'r1', tui: 'claude', terminalSpecId: 't1', fronted: true },
                ],
                allowed: input.allowed ?? [],
            }),
            mark: '',
            markError: null,
            switchError: input.switchError ?? null,
            onPick: () => {},
            onMark: () => {},
        }),
    );
}

describe('the driver menu', () => {
    it('offers every driver but the one in the chair', () => {
        const html = render({});
        expect(html).toContain('tui-switch-codex');
        expect(html).toContain('tui-switch-genie');
        expect(html).toContain('tui-active-claude');
        expect(html).not.toContain('tui-switch-claude');
    });

    it('does not offer a driver this agent’s AGENT.md excludes', () => {
        const html = render({ allowed: ['claude', 'codex'] });
        expect(html).not.toContain('tui-switch-genie');
        expect(html).toContain('tui-refused-genie');
        // POSITIVE CONTROL: a menu that rendered no switches at all would pass
        // the two lines above, so pin a permitted one in the same render.
        expect(html).toContain('tui-switch-codex');
    });

    it('marks a held-but-parked driver as a sidecar', () => {
        const html = render({
            runtimes: [
                { id: 'r1', tui: 'claude', terminalSpecId: 't1', fronted: true },
                { id: 'r2', tui: 'codex', terminalSpecId: 't2', fronted: false },
            ],
        });
        expect(html).toContain('tui-switch-codex');
        expect(html).toContain('sidecar');
    });

    it('shows a refusal the host made AFTER the menu was drawn', () => {
        // The file can be edited between opening this and clicking; the click
        // must not silently do nothing.
        const html = render({ switchError: 'This agent does not list "genie".' });
        expect(html).toContain('tui-switch-error');
        expect(html).toContain('does not list &quot;genie&quot;');
    });

    it('POSITIVE CONTROL: no error is drawn when nothing was refused', () => {
        expect(render({})).not.toContain('tui-switch-error');
    });

    it('promises, in the menu itself, that a switch stops nothing', () => {
        expect(render({})).toMatch(/nothing is stopped/i);
    });
});
