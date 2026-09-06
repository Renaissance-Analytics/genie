import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolUpdateList } from '../../pages/settings';
import { agentCliRows } from '../../lib/toolchain-page';
import { toolUpdateRows } from '../../lib/workstation-dev-server';
import {
    AGENT_CLI_CATALOG,
    AGENT_CLI_IDS,
    agentCliDef,
} from '../../../main/agents/agent-cli-catalog';
import type { ToolUpdate } from '../../lib/genie';

/**
 * The Agent CLIs tab, rendered — every row the catalog can produce.
 *
 * This tab had no render coverage at all. The E2E that clicks "Agent CLIs" runs
 * against `pages/e2e-hosting.tsx` — a page built for the suite — with an eight-row
 * fixture, so the shapes it exercises are the shapes somebody wrote down, and
 * the twenty-one the catalog actually produces on a real machine had never been
 * put through the component. That is a gap worth closing on its own terms: the
 * panel mounts LAZILY (`Tabs.Panel` returns null until its tab is selected), so
 * a throw in it is a throw the first time a person clicks the tab, which is
 * exactly what the owner reported.
 *
 * The renderer test env has no DOM, so this uses the server renderer: it runs
 * every component function and throws where the browser would for a render-phase
 * error, which is the class of fault an error boundary catches.
 */

/** One update row per catalog entry, in the state a fresh machine reports:
 *  nothing installed, nothing probed for latest. */
function machineWithNothingInstalled(): ToolUpdate[] {
    return AGENT_CLI_IDS.map((id) => ({
        name: id,
        updateAvailable: false,
        source: 'unknown' as const,
        ...(agentCliDef(id)?.probe ? {} : { probed: false as const }),
    }));
}

function render(updates: ToolUpdate[]): string {
    return renderToStaticMarkup(
        React.createElement(ToolUpdateList, {
            rows: toolUpdateRows(agentCliRows(updates)),
            busy: null,
            onUpdate: () => {},
            empty: 'No agent CLIs on this machine yet.',
            testId: 'agent-clis',
        }),
    );
}

describe('the Agent CLIs tab renders every row the catalog can produce', () => {
    it('renders one row per catalogued CLI, each named', () => {
        const html = render(machineWithNothingInstalled());
        // The positive control. "It did not throw" is also true of a component
        // that renders nothing, so every product NAME has to be on the page.
        for (const cli of AGENT_CLI_CATALOG) {
            expect(html, `${cli.id} is missing from the tab`).toContain(cli.label);
        }
        expect(AGENT_CLI_CATALOG.length).toBeGreaterThan(20);
    });

    it('offers Install where Genie has an installer, and the GAP where it has none', () => {
        const html = render(machineWithNothingInstalled());
        for (const cli of AGENT_CLI_CATALOG) {
            if (cli.install) {
                expect(html, `${cli.id} has an installer and no button`).toContain(
                    `devtool-install-${cli.id}`,
                );
            } else {
                // Never a button that would fail — the reason instead.
                expect(html, `${cli.id} has no installer and no reason`).toContain(
                    `devtool-gap-${cli.id}`,
                );
                expect(html).not.toContain(`devtool-install-${cli.id}`);
            }
        }
    });

    it('makes no claim about a CLI it never probed', () => {
        const unprobed = AGENT_CLI_IDS.filter((id) => !agentCliDef(id)?.probe);
        expect(unprobed.length, 'no unprobed CLI left to check').toBeGreaterThan(0);
        const html = render(
            // ONLY the unprobed ones, so "Not installed" cannot come from a
            // neighbouring row and make this pass for the wrong reason.
            unprobed.map((id) => ({
                name: id,
                updateAvailable: false,
                source: 'unknown' as const,
                probed: false as const,
            })),
        );
        expect(html).toContain('Not checked');
        expect(html).not.toContain('Not installed');
    });

    it('renders an installed row with its version, origin and directory', () => {
        // The shape a real machine answers with: a CLI another installer put on
        // PATH, which the row has to name without claiming Genie manages it.
        const html = render([
            {
                name: 'claude-code',
                installed: '2.1.263',
                updateAvailable: false,
                source: 'unknown',
                origin: {
                    managedByGenie: false,
                    source: 'npm-global',
                    directory: 'C:\Users\dev\AppData\Roaming\npm',
                },
            },
        ]);
        expect(html).toContain('Installed 2.1.263');
        expect(html).toContain('npm (global)');
        expect(html).toContain('Not managed');
    });
});
