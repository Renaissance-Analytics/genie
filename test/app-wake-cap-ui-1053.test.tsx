// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppWakeCap } from '../src/core/app-inbox.js';
import { settingsSections, type SettingsFacts } from '../src/core/agent-settings-view.js';
import type { LiveSession } from '../src/core/roster.js';
import { AgentView } from '../src/renderer/components/AgentView.js';
import { AppWakeCapControl } from '../src/renderer/components/AppWakeCapControl.js';

/**
 * THE APP WAKE CAP IN THE AGENT'S SETTINGS (Tynn #1053): one row on General, after Mode — a number field, a "No limit"
 * switch and one line saying what it is. It is drawn from the agent's detail and writes through the agents' own call;
 * the window keeps none of it. A value the host would refuse is not sent: the row says why, in the host's words.
 * Built from react-fancy's Input, Button and Switch, as the rows beside it are. Fixtures name no person.
 */

const source = (path: string): string => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');

describe('where it is: General, after Mode, only for a window that can set it', () => {
    const FACTS: SettingsFacts = { fidelity: 'declared', provider: 'claude', ops: true, model: true, tools: true, autonomous: true, manageTabs: true, drivePages: true, issueWatch: true, persona: true, skills: true };
    const general = (f: SettingsFacts) => settingsSections(f).find((s) => s.id === 'general')?.controls;

    it('the control is General’s, straight after Mode', () => {
        expect(general({ ...FACTS, appWakeCap: true } as SettingsFacts)).toEqual(['provider', 'model', 'mode', 'app-wake-cap', 'run', 'remove']);
    });

    it('CONTROL: a window that cannot set it has no such control', () => {
        expect(general(FACTS)).toEqual(['provider', 'model', 'mode', 'run', 'remove']);
    });

    const session = { running: true, turnState: 'idle', startedAt: 0, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, plan: null } as unknown as LiveSession;
    const AGENT = { id: 'kai', name: 'kai', provider: 'claude', fidelity: 'declared' as const, cwd: '/w' };
    const OPS = { deletePreview: null, diagnosis: null, lastOutcome: null, budgetUsd: null, mode: 'automated', accessScope: 'self', onSetMode: () => {}, onSetAccessScope: () => {}, onRestart: () => {}, onSwitchDriver: () => {}, onDiagnose: () => {}, onPreviewDelete: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onSetBudget: () => {} };
    const render = (ops: Record<string, unknown>) => renderToStaticMarkup(<AgentView agent={AGENT} session={session} rows={[]} tab="settings" settingsSection="general" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 0} ops={{ ...OPS, ...ops } as never} />);

    it('the agent’s Settings draws it on General with the value from the agent’s detail, after the Mode row', () => {
        const html = render({ appWakeCap: 9, onSetAppWakeCap: () => {} });
        expect(html).toContain('data-settings-row="app-wake-cap"');
        expect(html).toContain('data-app-wake-cap="9"');
        expect(html.indexOf('data-settings-row="app-wake-cap"')).toBeGreaterThan(html.indexOf('data-rail="mode"'));
        expect(html.indexOf('data-settings-row="app-wake-cap"')).toBeLessThan(html.indexOf('data-settings-row="run"'));
        expect(render({ appWakeCap: 'unlimited', onSetAppWakeCap: () => {} })).toContain('data-app-wake-cap="unlimited"');
    });

    it('CONTROL: no setter, no row; and it is not on Permissions', () => {
        expect(render({ appWakeCap: 9 })).not.toContain('data-settings-row="app-wake-cap"');
        const permissions = renderToStaticMarkup(<AgentView agent={AGENT} session={session} rows={[]} tab="settings" settingsSection="permissions" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 0} ops={{ ...OPS, appWakeCap: 9, onSetAppWakeCap: () => {} } as never} />);
        expect(permissions).not.toContain('data-settings-row="app-wake-cap"');
    });
});

describe('the control: a number field, a "No limit" switch, one line of explanation', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });

    const show = (cap: AppWakeCap, onSet = vi.fn()) => {
        act(() => root.render(<AppWakeCapControl agentName="kai" cap={cap} onSet={onSet} />));
        return onSet;
    };
    const row = () => host.querySelector('[data-settings-row="app-wake-cap"]') as HTMLElement;
    const field = () => row().querySelector('input[data-app-wake-cap-input]') as HTMLInputElement;
    const noLimit = () => row().querySelector('[role="switch"]') as HTMLElement;
    const setButton = () => row().querySelector('[data-action="app-wake-cap-set"]') as HTMLButtonElement;
    const refusal = () => row().querySelector('[data-app-wake-cap-refusal]')?.textContent ?? null;
    const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
    const type = async (text: string) => {
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), text);
            field().dispatchEvent(new Event('input', { bubbles: true }));
        });
    };

    it('shows the cap in force: the default 6 in a number field, "No limit" off, and what it means in one line', () => {
        show(6);
        expect(row().getAttribute('data-app-wake-cap')).toBe('6');
        expect(field().type).toBe('number');
        expect(field().value).toBe('6');
        expect(field().min).toBe('1');
        expect(field().step).toBe('1');
        expect(field().disabled).toBe(false);
        expect(noLimit().getAttribute('aria-checked')).toBe('false');
        expect(noLimit().getAttribute('aria-label')).toBe('No limit on app mail turns for kai');
        expect(field().getAttribute('aria-label')).toBe('App mail turns an hour for kai');
        expect(row().textContent).toContain('App mail turns');
        expect(row().textContent).toContain('No limit');
        const help = row().querySelectorAll('[data-app-wake-cap-help]');
        expect(help).toHaveLength(1);
        expect(help[0]!.textContent).toBe('Mail from this workspace’s apps gives kai at most this many turns an hour; more of it waits, and none is lost.');
    });

    it('a new number is sent when Set is pressed, as a number; Set is offered only for a number that differs', async () => {
        const onSet = show(6);
        expect(setButton().disabled).toBe(true);
        await type('12');
        expect(setButton().disabled).toBe(false);
        expect(onSet).not.toHaveBeenCalled();
        await click(setButton());
        expect(onSet).toHaveBeenCalledExactlyOnceWith(12);
    });

    it('Enter in the field sends it too', async () => {
        const onSet = show(6);
        await type('20');
        await act(async () => { field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        expect(onSet).toHaveBeenCalledExactlyOnceWith(20);
    });

    it.each(['0', '-3', '2.5', '', 'abc'])('"%s" is not sent: the row says why, in the host’s words', async (text) => {
        const onSet = show(6);
        await type(text);
        await click(setButton());
        await act(async () => { field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        expect(onSet).not.toHaveBeenCalled();
        expect(refusal()).toMatch(/whole number of wakes an hour, 1 or more/);
    });

    it('CONTROL: a valid number shows no refusal', async () => {
        show(6);
        await type('12');
        expect(refusal()).toBeNull();
    });

    it('"No limit" on sends the word "unlimited" — never a zero, a blank or a large number', async () => {
        const onSet = show(6);
        await click(noLimit());
        expect(onSet).toHaveBeenCalledExactlyOnceWith('unlimited');
    });

    it('with no limit in force the switch is on and the number field is off; switching it off sends the default, 6', async () => {
        const onSet = show('unlimited');
        expect(row().getAttribute('data-app-wake-cap')).toBe('unlimited');
        expect(noLimit().getAttribute('aria-checked')).toBe('true');
        expect(field().disabled).toBe(true);
        await click(noLimit());
        expect(onSet).toHaveBeenCalledExactlyOnceWith(6);
    });

    it('it follows the host: a cap changed elsewhere is shown when the detail brings it', () => {
        show(6);
        show(30);
        expect(field().value).toBe('30');
        show('unlimited');
        expect(noLimit().getAttribute('aria-checked')).toBe('true');
    });
});

describe('built from the components the rows beside it use', () => {
    it('react-fancy’s Input, Button and Switch; no raw input or button of its own', () => {
        const code = source('src/renderer/components/AppWakeCapControl.tsx');
        expect(code).toMatch(/import \{ Button, Input, Switch \} from '@particle-academy\/react-fancy'/);
        expect(code).not.toMatch(/<input\b/);
        expect(code).not.toMatch(/<button\b/);
    });
});
