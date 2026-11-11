// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginsPage } from '../src/renderer/components/PluginsPage.js';
import type { ActOutcome, FeatureAction, FeatureData } from '../src/renderer/features.js';

/**
 * ADF B8 (Tynn #458; spec .ai/plans/specs/adf-sdk.md, story B8): SETTINGS → PLUGINS AS THE CATALOG VIEW. Every package,
 * Genie's own and anyone else's, as a card: its publisher, its trust (Signed by X, Official, Unverified, or Refused with
 * why in one sentence), what it adds, what it may touch, and a Switch that shows progress then success or failure with
 * Retry. Tabs Installed, Marketplace (a slot the marketplace pane fills) and Developers.
 * Interaction is a claim about a live DOM, so this renders in happy-dom (docs/decisions.md D4).
 */
type Plugins = NonNullable<FeatureData['plugins']>;
type Entry = Plugins['entries'][number];

const signed: Entry = {
    id: 'com.example.signed', folder: 'signed', name: 'Board', version: '1.2.0', state: 'enabled', label: 'signed by sha256:abc', reason: null,
    publisher: 'Example Co', unverified: false, networkHosts: ['api.example.com'], networkAllowed: true,
    adds: { tools: ['append'], panels: ['Board'], editors: ['Deck'] }, touches: { files: ['.md', '.txt'], network: ['api.example.com'], genieApi: ['knowledge.search'] },
};
const unverified: Entry = {
    id: 'com.example.local', folder: 'local', name: 'Local', version: '0.1.0', state: 'enabled', label: 'Unverified', reason: null,
    publisher: 'Me', unverified: true, networkHosts: [], networkAllowed: false, adds: { tools: ['probe'], panels: [], editors: [] }, touches: { files: null, network: [], genieApi: [] },
};
const REASON = 'unsigned plugins are not installed: no signature file (genie-plugin.sig) beside the manifest; turn off publisher checks (Settings → Plugins) to run it at your own risk, labelled Unverified.';
const refused: Entry = { id: 'com.example.refused', folder: 'refused', name: 'Refused', version: '1.0.0', state: 'refused', label: null, reason: REASON, publisher: 'Someone' };
const official: Entry = {
    id: 'ai.genie.spreadsheet', folder: '(official)', name: 'Spreadsheet', version: '1.0.0', state: 'enabled', label: 'official — ships with Genie', reason: null,
    publisher: 'Genie', unverified: false, networkHosts: [], networkAllowed: true, adds: { tools: ['createWorkbook'], panels: [], editors: ['Sheet'] }, touches: { files: null, network: [], genieApi: [] },
};
const off: Entry = { ...signed, id: 'com.example.off', name: 'Off', state: 'disabled' };

const plugins = (entries: readonly Entry[], over: Partial<Plugins> = {}): Plugins => ({ dir: '/home/u/.genie/plugins', publisherChecksOff: false, panels: [], entries, ...over } as Plugins);

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
let actions: FeatureAction[];
let answer: () => Promise<ActOutcome> | void;
beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    actions = [];
    answer = () => Promise.resolve({ ok: true });
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});
const draw = (p: Plugins, marketplace?: React.ReactNode) => act(() => {
    root.render(<PluginsPage plugins={p} onAction={(a) => { actions.push(a); return answer(); }} {...(marketplace ? { marketplace } : {})} />);
});
const card = (id: string) => document.querySelector(`[data-plugin="${id}"]`)!;
const badge = (id: string) => card(id).querySelector('[data-package-badge]')?.textContent;
const switchOf = (id: string) => card(id).querySelector('[data-plugin-switch] [aria-checked]') as HTMLElement | null;
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); await Promise.resolve(); }); };
const tab = (name: string) => [...document.querySelectorAll('[role="tab"], button')].find((b) => b.textContent?.trim() === name) ?? null;

describe('every package says who it is from and whether Genie trusts it', () => {
    it('a signed, an unverified and a refused package: the three badges, and the refused reason in one sentence', () => {
        draw(plugins([signed, unverified, refused]));
        expect(badge(signed.id)).toBe('Signed by Example Co');
        expect(badge(unverified.id)).toBe('Unverified');
        expect(badge(refused.id)).toBe('Refused');
        const reason = card(refused.id).querySelector('[data-package-reason]')?.textContent;
        expect(reason).toBe(REASON);
        expect(reason).not.toMatch(/\. [A-Z]/);
    });

    it('Genie\'s own packages are listed the same way, badged Official', () => {
        draw(plugins([official]));
        expect(badge(official.id)).toBe('Official');
    });

    it('each card names the publisher, what it adds and what it may touch', () => {
        draw(plugins([signed]));
        const text = card(signed.id).textContent!;
        expect(text).toContain('Example Co');
        expect(card(signed.id).querySelector('[data-package-adds]')?.textContent).toMatch(/append[\s\S]*Board[\s\S]*Deck/);
        const touches = card(signed.id).querySelector('[data-package-touches]')?.textContent;
        expect(touches).toMatch(/\.md/);
        expect(touches).toMatch(/api\.example\.com/);
        expect(touches).toMatch(/knowledge\.search/);
    });

    it('a package that asks for nothing says so', () => {
        draw(plugins([unverified]));
        expect(card(unverified.id).querySelector('[data-package-touches]')?.textContent).toMatch(/Nothing/);
    });
});

describe('enable and disable show what happened', () => {
    it('a refused package has no Switch; an installable one does, showing its state', () => {
        draw(plugins([signed, off, refused]));
        expect(switchOf(signed.id)?.getAttribute('aria-checked')).toBe('true');
        expect(switchOf(off.id)?.getAttribute('aria-checked')).toBe('false');
        expect(switchOf(refused.id)).toBeNull();
    });

    it('turning one off shows progress, then success', async () => {
        let finish!: (o: ActOutcome) => void;
        answer = () => new Promise((resolve) => { finish = resolve; });
        draw(plugins([signed]));
        await click(switchOf(signed.id));
        expect(actions).toEqual([{ kind: 'plugins.setEnabled', id: signed.id, enabled: false }]);
        expect(card(signed.id).querySelector('[data-package-progress]')).not.toBeNull();
        await act(async () => { finish({ ok: true }); await Promise.resolve(); });
        expect(card(signed.id).querySelector('[data-package-progress]')).toBeNull();
        expect(card(signed.id).querySelector('[data-package-done]')).not.toBeNull();
    });

    it('a failure says why, and Retry sends the same change again', async () => {
        answer = () => Promise.resolve({ ok: false, reason: 'the host could not change it' });
        draw(plugins([off]));
        await click(switchOf(off.id));
        await act(async () => { await Promise.resolve(); });
        const problem = card(off.id).querySelector('[data-package-problem]');
        expect(problem?.textContent).toContain('the host could not change it');
        answer = () => Promise.resolve({ ok: true });
        await click(card(off.id).querySelector('[data-action="package-retry"]'));
        await act(async () => { await Promise.resolve(); });
        expect(actions).toEqual([{ kind: 'plugins.setEnabled', id: off.id, enabled: true }, { kind: 'plugins.setEnabled', id: off.id, enabled: true }]);
        expect(card(off.id).querySelector('[data-package-problem]')).toBeNull();
    });

    it('a change that throws is a failure too, never silence', async () => {
        answer = () => Promise.reject(new Error("Error invoking remote method 'x': Error: it broke"));
        draw(plugins([off]));
        await click(switchOf(off.id));
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(card(off.id).querySelector('[data-package-problem]')?.textContent).toContain('it broke');
    });

    it('while a change is in flight the Switch cannot start another', async () => {
        answer = () => new Promise(() => {});
        draw(plugins([signed]));
        await click(switchOf(signed.id));
        await click(switchOf(signed.id));
        expect(actions).toHaveLength(1);
    });
});

describe('the tabs', () => {
    it('Installed first; nothing installed says where packages go', () => {
        draw(plugins([]));
        expect(document.querySelector('[data-plugins-tab="installed"]')?.textContent).toMatch(/No plugins yet/);
    });

    it('Marketplace is a slot: empty, it says so; given a pane, it holds it', async () => {
        draw(plugins([signed]));
        await click(tab('Marketplace'));
        expect(document.querySelector('[data-plugins-tab="marketplace"] [data-marketplace-empty]')).not.toBeNull();
        draw(plugins([signed]), <div data-test-pane="">the pane</div>);
        expect(document.querySelector('[data-plugins-tab="marketplace"] [data-test-pane]')).not.toBeNull();
        expect(document.querySelector('[data-marketplace-empty]')).toBeNull();
    });

    it('Developers says where packages live and how the format is documented', async () => {
        draw(plugins([signed]));
        await click(tab('Developers'));
        const text = document.querySelector('[data-plugins-tab="developers"]')?.textContent;
        expect(text).toContain('/home/u/.genie/plugins');
        expect(text).toContain('docs/sdk');
    });

    it('the publisher-checks switch and banner stay above the tabs', () => {
        draw(plugins([signed], { publisherChecksOff: true }));
        expect(document.querySelector('[data-publisher-checks]')).not.toBeNull();
        expect(document.querySelector('[data-publisher-checks-banner]')).not.toBeNull();
    });
});

describe('source guard', () => {
    it('every action on the page is a react-fancy control: no bare button, link or clickable element', () => {
        const source = readFileSync(join(__dirname, '..', 'src', 'renderer', 'components', 'PluginsPage.tsx'), 'utf8');
        expect(source).toMatch(/<Button\b/);
        expect(source).not.toMatch(/<button\b/);
        expect(source).not.toMatch(/<a\b/);
        expect(source).not.toMatch(/<(div|span|li|p|section|ul|label)\b[^>]*\bonClick=/);
    });
});
