// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DND_SETTING, dndHeader, dndToggleAction, type DndHeaderView } from '../src/core/dnd-header.js';
import { SETTINGS } from '../src/core/settings.js';
import { EMPTY_SNAPSHOT, NO_FILES } from '../src/renderer/bridge.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';
import { EMPTY_FEATURES, type FeatureAction, type FeatureData } from '../src/renderer/features.js';
import { ICON_NAMES, registerAppIcons } from '../src/renderer/icons.js';
import { Shell } from '../src/renderer/Shell.js';
import { control } from './helpers/control-markup.js';

/**
 * DO NOT DISTURB IS A TOGGLE IN THE APP HEADER, AND IT'S OBVIOUS WHEN IT'S ON (Tynn #655). The owner: "it should be obvious
 * to the user when they have DND turned on. in fact, that should be a toggle in the app header, not buried in settings."
 *
 *  - one click in the header turns it on or off;
 *  - on, the header says so unmistakably (bell-off icon, the warning colour, pressed) in every window — the title bar is
 *    the one chrome on every surface, local or another machine's;
 *  - it is the SAME setting Settings → General shows (`do_not_disturb`), so the two are in sync live: both read the host's
 *    settings snapshot, which is pushed to every window on any change;
 *  - its tooltip says what DND holds back.
 */
registerAppIcons();
const noop = () => {};
const view = (values: Record<string, boolean | string> | null) => dndHeader(values);
const bar = (dnd?: { view: DndHeaderView; onToggle: () => unknown }) =>
    renderToStaticMarkup(<TitleBar route="genie://dashboard" workstation={{ name: 'alphar', healthy: true }} onNavigate={noop} onOpenPalette={noop} dnd={dnd} />);

describe('what the header reads from the setting', () => {
    it('not known yet (no settings snapshot): no control, never a guessed "off"', () => {
        expect(view(null)).toBeNull();
    });

    it('on: the bell-off icon, and a tooltip that says what it holds back and how to turn it off', () => {
        const on = view({ do_not_disturb: true, dnd_reply: 'Back at 3.' })!;
        expect(on.on).toBe(true);
        expect(on.icon).toBe('bell-off');
        expect(on.label).toBe('Do not disturb is on');
        expect(on.tooltip).toMatch(/^Do not disturb is on/);
        expect(on.tooltip).toMatch(/pop-ups/);
        expect(on.tooltip).toMatch(/sounds/);
        // What an agent that asks is told: the person's own reply, verbatim.
        expect(on.tooltip).toContain('“Back at 3.”');
        expect(on.tooltip).toMatch(/Click to turn it off/);
    });

    it('on with the question chime kept: the tooltip says questions still chime (CONTROL: without it, it does not)', () => {
        expect(view({ do_not_disturb: true, dnd_question_sound: true })!.tooltip).toMatch(/questions still chime/);
        expect(view({ do_not_disturb: true, dnd_question_sound: false })!.tooltip).not.toMatch(/questions still chime/);
    });

    it('off (or never set): the plain bell, and what turning it on would do', () => {
        for (const values of [{ do_not_disturb: false }, {}]) {
            const off = view(values)!;
            expect(off.on).toBe(false);
            expect(off.icon).toBe('bell');
            expect(off.label).toBe('Do not disturb is off');
            expect(off.tooltip).toMatch(/^Do not disturb is off/);
            expect(off.tooltip).toMatch(/Click to hold back pop-ups and sounds/);
        }
    });
});

describe('the one setting', () => {
    it('the header writes Settings → General’s own `do_not_disturb`, the host’s, never a second copy', () => {
        expect(DND_SETTING).toBe('do_not_disturb');
        const def = SETTINGS.find((s) => s.key === DND_SETTING);
        expect(def?.type).toBe('boolean');
        expect(def?.scope).toBe('host');
        expect(dndToggleAction(false)).toEqual({ kind: 'settings.set', key: 'do_not_disturb', value: true });
        expect(dndToggleAction(true)).toEqual({ kind: 'settings.set', key: 'do_not_disturb', value: false });
    });

    it('its icons are registered (an unregistered name renders an empty span)', () => {
        expect(ICON_NAMES).toContain('bell');
        expect(ICON_NAMES).toContain('bell-off');
    });
});

describe('the header control', () => {
    it('on: a react-fancy Button, pressed, the warning colour, the bell-off glyph, data-dnd="on"', () => {
        const html = bar({ view: view({ do_not_disturb: true })!, onToggle: noop });
        const c = control(html, 'data-system-icon="DoNotDisturb"');
        expect(c).not.toBeNull();
        expect(c!.fancy).toBe(true);
        expect(c!.open).toContain('data-dnd="on"');
        expect(c!.open).toContain('aria-pressed="true"');
        expect(c!.open).toContain('aria-label="Do not disturb is on"');
        expect(c!.open).toMatch(/bg-\[var\(--warning\)\]/);
        expect(c!.inner).toContain('<svg');
        expect(c!.inner).toContain('data-dnd-icon="bell-off"');
    });

    it('off: not pressed, no warning colour, the plain bell (CONTROL for the on state)', () => {
        const html = bar({ view: view({ do_not_disturb: false })!, onToggle: noop });
        const c = control(html, 'data-system-icon="DoNotDisturb"');
        expect(c).not.toBeNull();
        expect(c!.open).toContain('data-dnd="off"');
        expect(c!.open).toContain('aria-pressed="false"');
        expect(c!.open).not.toMatch(/bg-\[var\(--warning\)\]/);
        expect(c!.inner).toContain('data-dnd-icon="bell"');
        expect(c!.inner).toContain('<svg');
    });

    it('absent: no control', () => {
        expect(bar()).not.toContain('data-system-icon="DoNotDisturb"');
    });
});

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });

describe('one click', () => {
    it('a click toggles, once; a new snapshot redraws the state (live: off → on → off)', () => {
        let toggles = 0;
        const render = (on: boolean) => act(() => root.render(
            <TitleBar route="genie://dashboard" workstation={null} onNavigate={noop} onOpenPalette={noop} dnd={{ view: view({ do_not_disturb: on })!, onToggle: () => { toggles += 1; } }} />,
        ));
        render(false);
        const button = () => host.querySelector<HTMLButtonElement>('[data-system-icon="DoNotDisturb"]');
        expect(button()?.getAttribute('data-dnd')).toBe('off');
        act(() => { button()?.click(); });
        expect(toggles).toBe(1);
        render(true);
        expect(button()?.getAttribute('data-dnd')).toBe('on');
        render(false);
        expect(button()?.getAttribute('data-dnd')).toBe('off');
    });
});

describe('in the shell — every window, local or another machine’s, draws the same Shell and title bar', () => {
    const shell = (values: FeatureData['settings']['values'], onFeature: (a: FeatureAction) => unknown = noop) => (
        <Shell
            route="genie://dashboard?group=workspace" snapshot={EMPTY_SNAPSHOT} servable={['dashboard', 'deck', 'agent', 'workspace', 'settings']}
            agentDetail={null} agentResolved={false} selectedRowId={null} chatThread={null} pinned={null} files={NO_FILES}
            features={{ ...EMPTY_FEATURES, settings: { values } }}
            onNavigate={noop} onOpenAgent={noop} onAddAgent={noop} onAddWorkspace={noop} onOpenPalette={noop} onSelectRow={noop}
            onSend={noop} onToggleFilesPin={noop} onCloseChat={noop} answeringApproval={null} onAnswerApproval={noop} onAnswerDeckItem={noop}
            onFeature={onFeature as never}
        />
    );

    it('the header reads the host’s settings snapshot — the one Settings draws (on, off, not yet known)', () => {
        expect(renderToStaticMarkup(shell({ do_not_disturb: true }))).toContain('data-dnd="on"');
        expect(renderToStaticMarkup(shell({ do_not_disturb: false }))).toContain('data-dnd="off"');
        expect(renderToStaticMarkup(shell(null))).not.toContain('data-system-icon="DoNotDisturb"');
    });

    it('a click writes the setting through the window’s own feature channel (the host it shows)', () => {
        const sent: FeatureAction[] = [];
        act(() => root.render(shell({ do_not_disturb: false }, (a) => { sent.push(a); return Promise.resolve({ ok: true }); })));
        act(() => { host.querySelector<HTMLButtonElement>('[data-system-icon="DoNotDisturb"]')?.click(); });
        expect(sent).toEqual([{ kind: 'settings.set', key: 'do_not_disturb', value: true }]);
    });

    it('Settings still draws the same key (it is not moved out of Settings)', () => {
        expect(readFileSync('src/core/settings-nav.ts', 'utf8')).toMatch(/do_not_disturb: 'general'/);
    });
});
