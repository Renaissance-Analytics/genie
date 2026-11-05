// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newAgentRefusal } from '../src/core/agent-create.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { AgentRosterView } from '../src/renderer/components/ImportedAgents.js';
import { NewAgentView } from '../src/renderer/components/NewAgentModal.js';
import { Workspace } from '../src/renderer/components/Workspace.js';
import { control } from './helpers/control-markup.js';

/**
 * ANOTHER AGENT, ALWAYS ONE CLICK AWAY (Tynn story #381; the owner: "make sure this next release has the ability to create
 * additional agents"). The workspace dashboard offered "+ Add agent" only while the workspace had NO agents, so with one
 * agent there was no way to add a second. Now:
 *  - the dashboard has an "Add agent" react-fancy Button in a fixed header row ABOVE the lanes — there with no agents, one
 *    or many, in the same place, so it never moves as lanes come and go;
 *  - the workspace settings' Agents section has the same action under "Registered";
 *  - both open the existing New agent form for that workspace (onAddAgent), whose duplicate name is refused in words.
 *
 * Interaction is a claim about a live DOM, so this file renders in happy-dom (docs/decisions.md D4).
 */
const base: AgentRow = {
    id: 'a1', name: 'kai', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'idle',
    duration: '1m', ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null,
    collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
} as unknown as AgentRow;
const kai = base;
const wren = { ...base, id: 'a2', name: 'wren' } as AgentRow;
const workspace = { id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' };
const html = (rows: AgentRow[]) => renderToStaticMarkup(<Workspace view="home" workspace={workspace} terminals={NO_TERMINALS} rows={rows} deckItems={[]} onAddAgent={() => {}} />);
const count = (h: string, attr: string) => (h.match(new RegExp(`${attr}="`, 'g')) ?? []).length;
/** The dashboard's children, in order, as tags with their marks: what sits above the lanes. */
const headerBeforeLanes = (h: string): string => {
    const dash = h.indexOf('data-workspace-dashboard="tynn"');
    const firstLane = h.indexOf('data-dash-lane="', dash);
    return h.slice(dash, firstLane < 0 ? undefined : firstLane);
};

describe('the workspace dashboard always offers Add agent', () => {
    it('with ONE agent: an "Add agent" react-fancy Button in the header row above its lane (the case that had none)', () => {
        const one = html([kai]);
        expect(count(one, 'data-dash-lane')).toBe(1);
        const button = control(one, 'data-action="add-agent"');
        expect(button).toMatchObject({ tag: 'button', fancy: true, text: 'Add agent' });
        expect(headerBeforeLanes(one)).toContain('data-action="add-agent"');
        expect(headerBeforeLanes(one)).toContain('data-dash-header=""');
    });

    it('with none, one or two agents it is the same button in the same header row (it never moves as lanes change)', () => {
        const shapes = [html([]), html([kai]), html([kai, wren])].map((h) => {
            const head = h.slice(h.indexOf('data-dash-header=""'));
            return head.slice(0, head.indexOf('</div>'));
        });
        expect(shapes[0]).toContain('data-action="add-agent"');
        expect(shapes[1]).toBe(shapes[0]);
        expect(shapes[2]).toBe(shapes[0]);
        // A second agent created appears as a lane of its own (COUNTED).
        expect(count(html([kai, wren]), 'data-dash-lane')).toBe(2);
    });
});

describe('the settings’ Agents section offers it too', () => {
    it('under "Registered", the same "Add agent" react-fancy Button', () => {
        const props = { registered: [{ id: 'a1', name: 'kai', provider: 'claude' }], onDisk: [], busy: null, notice: null, error: null, onReattach: () => {}, onAddAgent: () => {} };
        const h = renderToStaticMarkup(<AgentRosterView {...(props as never)} />);
        const registered = h.slice(h.indexOf('data-roster-registered'), h.indexOf('data-roster-on-disk'));
        expect(control(registered, 'data-action="add-agent"')).toMatchObject({ tag: 'button', fancy: true, text: 'Add agent' });
    });
});

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });

describe('pressing it opens the New agent form for this workspace', () => {
    it('the dashboard’s, with one agent: onAddAgent once (COUNTED)', () => {
        let asked = 0;
        act(() => root.render(<Workspace view="home" workspace={workspace} terminals={NO_TERMINALS} rows={[kai]} deckItems={[]} onAddAgent={() => { asked += 1; }} />));
        const button = host.querySelector('[data-workspace-dashboard] [data-action="add-agent"]') as HTMLButtonElement | null;
        expect(button).not.toBeNull();
        act(() => { button!.click(); });
        expect(asked).toBe(1);
    });

    it('the settings’, under Registered: its onAddAgent once', () => {
        let asked = 0;
        const props = { registered: [{ id: 'a1', name: 'kai', provider: 'claude' }], onDisk: [], busy: null, notice: null, error: null, onReattach: () => {}, onAddAgent: () => { asked += 1; } };
        act(() => root.render(<AgentRosterView {...(props as never)} />));
        const button = host.querySelector('[data-roster-registered] [data-action="add-agent"]') as HTMLButtonElement | null;
        expect(button).not.toBeNull();
        act(() => { button!.click(); });
        expect(asked).toBe(1);
    });
});

describe('a duplicate name is refused in words', () => {
    it('the form says it, beside Create (control: a new name is accepted)', () => {
        const refusal = newAgentRefusal({ name: 'kai', purpose: 'Second opinion', provider: 'claude', existing: ['kai'], sacredName: null });
        expect(refusal).toBe('This workspace already has an agent named kai.');
        expect(newAgentRefusal({ name: 'wren', purpose: 'Second opinion', provider: 'claude', existing: ['kai'], sacredName: null })).toBeNull();
        const form = renderToStaticMarkup(<NewAgentView workspaceName="Tynn.ai" name="kai" purpose="Second opinion" provider="claude" busy={false} error={refusal} onName={() => {}} onPurpose={() => {}} onProvider={() => {}} onCreate={() => {}} onCancel={() => {}} />);
        expect(form).toMatch(/data-new-agent-error=""[^>]*>This workspace already has an agent named kai\.</);
    });
});
