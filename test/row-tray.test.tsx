import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { dashboardAction } from '../src/core/keys.js';
import { trayOf } from '../src/core/row-tray.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';

/**
 * THE ROW TRAY (§4.1 keyboard: `Space` toggles it; `.ai/plans/genie-2-dashboard-design.md` §2.3). The row's prose
 * columns are one line each; the tray is where the rest lives — READ-ONLY plus three doors: `Open agent →`,
 * `Terminal →`, `Files →`. No approve, no deny, no composer: a Dashboard that resolves is a Deck. Each section is
 * drawn only when the row measured it (the null rule): the target with its plan step, the latest delivery, the
 * context against the window.
 */
function row(over: Partial<AgentRow>): AgentRow {
    return {
        id: 'kai', name: 'kai', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working', duration: '6m',
        ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null,
        collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
        ...over,
    };
}
const full = row({
    step: '3/7', target: 'verify the install',
    delivery: { kind: 'file', main: 'main/acp/install.ts', sub: null, plus: 42, minus: 8, age: '14m' },
    contextUsed: 178_000, contextSize: 200_000,
});
const doors = [
    { door: 'agent', label: 'Open agent →', route: 'genie://agent/kai' },
    { door: 'terminal', label: 'Terminal →', route: 'genie://workspace/tynn' },
    { door: 'files', label: 'Files →', route: 'genie://workspace/tynn?files=' },
];

describe('trayOf', () => {
    it('the measured sections and the three doors', () => {
        expect(trayOf(full)).toEqual({
            target: { step: '3/7', text: 'verify the install' },
            delivered: { kind: 'file', main: 'main/acp/install.ts', plus: 42, minus: 8, age: '14m' },
            context: { used: 178_000, size: 200_000 },
            doors,
        });
    });

    it('what the row did not measure is absent, never empty — the doors remain', () => {
        expect(trayOf(row({}))).toEqual({ target: null, delivered: null, context: null, doors });
    });
});

describe('the board', () => {
    const render = (trayId: string | null) =>
        renderToStaticMarkup(<Dashboard rows={[full, row({ id: 'wren', name: 'wren' })]} workspaces={[{ id: 'tynn', path: '/w/tynn' }]} onOpenAgent={() => {}} onAddAgent={() => {}} onAddWorkspace={() => {}} trayId={trayId} />);

    it('opens under its row: target, delivered, context, the doors — and nothing that resolves', () => {
        const html = render('kai');
        expect(html).toMatch(/data-agent="kai"[\s\S]*data-row-tray="kai"[\s\S]*data-agent="wren"/);
        for (const s of ['target', 'delivered', 'context']) expect(html).toContain(`data-tray-section="${s}"`);
        expect(html).toMatch(/data-tray-section="target"[\s\S]*3\/7[\s\S]*verify the install/);
        expect(html).toMatch(/data-tray-section="context"[\s\S]*178k \/ 200k/);
        expect(html).toMatch(/data-door="agent"[^>]*>Open agent →</);
        expect(html).toMatch(/data-door="terminal"[^>]*>Terminal →</);
        expect(html).toMatch(/data-door="files"[^>]*>Files →</);
        const tray = html.slice(html.indexOf('data-row-tray="kai"'), html.indexOf('data-agent="wren"'));
        expect(tray).not.toMatch(/data-action="(allow|deny|answer)"|<textarea/);
    });

    it('closed, there is no tray (positive control above)', () => {
        expect(render(null)).not.toContain('data-row-tray');
    });

    it('Space toggles the tray on the row cursor; never while typing', () => {
        expect(dashboardAction({ key: ' ', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing: false })).toBe('tray');
        expect(dashboardAction({ key: ' ', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing: true })).toBeNull();
    });
});
