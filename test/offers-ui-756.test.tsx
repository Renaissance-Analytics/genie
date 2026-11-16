// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloneOffer } from '../src/core/clone-offers.js';
import { offersDialogView } from '../src/core/offers-dialog-view.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { OffersView } from '../src/renderer/components/OffersDialog.js';
import { Workspace } from '../src/renderer/components/Workspace.js';
import { control } from './helpers/control-markup.js';

/**
 * THE OFFERS, WHAT A PERSON SEES (Tynn #756, the offers UI): a count on the workspace dashboard, one click from the workspace; a dialog
 * with each offer's two sides; an Apply (react-fancy Button) on a new one and none on a changed one, which says Genie does not
 * replace it; and before the workspace is trusted, a command offer shows what it would run and the trust step's button instead.
 */

const logDoc = { version: 1, graph: { nodes: [{ id: 'l', kind: 'log', config: { message: 'tick' } }], edges: [] } };
const runDoc = { version: 1, graph: { nodes: [{ id: 's', kind: 'genie/terminal_run', config: { workspace: '${workspace}', command: 'npm run backup' } }], edges: [] } };
const newOffer = (over: Partial<CloneOffer> = {}): CloneOffer => ({ id: 'flow:.flows/a.json', kind: 'flow', file: '.flows/a.json', change: 'new', summary: 'New flow: a', incoming: logDoc, local: null, ...over });
const changed = newOffer({ id: 'flow:.flows/b.json', file: '.flows/b.json', change: 'changed', summary: 'Changed flow: b', incoming: runDoc, local: logDoc });
const noop = () => {};
const html = (offers: CloneOffer[], over: { trusted?: boolean; busy?: string | null } = {}) => renderToStaticMarkup(
    <OffersView workspaceName="Acme" view={offersDialogView({ offers, trusted: over.trusted ?? true, busy: over.busy ?? null, error: null, notes: {} })} onApply={noop} onTrust={noop} onClose={noop} />,
);

describe('the dialog', () => {
    it('each offer shows its summary and what the repo says; a new one has an Apply, a react-fancy Button', () => {
        const h = html([newOffer()]);
        expect(h).toContain('New flow: a');
        expect(control(h, 'data-action="apply-offer"')).toMatchObject({ tag: 'button', fancy: true, text: 'Apply' });
    });

    it('a changed one shows both sides, no Apply, and says Genie does not replace it', () => {
        const h = html([changed]);
        expect(h).toContain('data-offer-local');
        expect(h).toContain('data-offer-incoming');
        expect(h).toContain('Genie does not replace it');
        expect(h).not.toContain('data-action="apply-offer"');
    });

    it('before the trust, a command offer shows what it would run and the trust button, not an Apply', () => {
        const h = html([newOffer({ incoming: runDoc })], { trusted: false });
        expect(h).toContain('npm run backup');
        expect(control(h, 'data-action="trust-workspace"')).toMatchObject({ fancy: true });
        expect(h).not.toContain('data-action="apply-offer"');
    });

    it('CONTROL: after the trust the same offer has its Apply, and a quiet one never needed the trust', () => {
        expect(control(html([newOffer({ incoming: runDoc })], { trusted: true }), 'data-action="apply-offer"')).not.toBeNull();
        expect(html([newOffer()], { trusted: false })).not.toContain('data-action="trust-workspace"');
    });

    it('nothing offered says so', () => {
        expect(html([])).toContain('data-offers-empty');
    });
});

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });

describe('pressing', () => {
    it('Apply asks to apply that offer once; the trust button asks to trust once', () => {
        const heard: string[] = [];
        const view = offersDialogView({ offers: [newOffer(), newOffer({ id: 'flow:.flows/r.json', file: '.flows/r.json', summary: 'New flow: r', incoming: runDoc })], trusted: false, busy: null, error: null, notes: {} });
        act(() => root.render(<OffersView workspaceName="Acme" view={view} onApply={(id) => heard.push(`apply ${id}`)} onTrust={() => heard.push('trust')} onClose={noop} />));
        act(() => { (host.querySelector('[data-action="apply-offer"]') as HTMLButtonElement).click(); });
        act(() => { (host.querySelector('[data-action="trust-workspace"]') as HTMLButtonElement).click(); });
        expect(heard).toEqual(['apply flow:.flows/a.json', 'trust']);
    });
});

describe('the workspace dashboard header', () => {
    const workspace = { id: 'acme', name: 'Acme', path: '/w/acme' };
    const markup = (extra: { offers?: { count: number; onOpen: () => void } } = {}) => renderToStaticMarkup(<Workspace view="home" workspace={workspace} terminals={NO_TERMINALS} rows={[]} deckItems={[]} onAddAgent={noop} {...extra} />);

    it('shows the count of repo changes in a react-fancy Button beside Add agent, one click from the workspace', () => {
        const h = markup({ offers: { count: 3, onOpen: noop } });
        expect(control(h, 'data-action="clone-offers"')).toMatchObject({ tag: 'button', fancy: true });
        expect(control(h, 'data-action="clone-offers"')!.text).toContain('3');
        const head = h.slice(h.indexOf('data-dash-header=""'));
        expect(head.slice(0, head.indexOf('</div>'))).toContain('data-action="clone-offers"');
    });

    it('CONTROL: with no offers there is no badge, and pressing it opens the dialog once', () => {
        expect(markup()).not.toContain('data-action="clone-offers"');
        expect(markup({ offers: { count: 0, onOpen: noop } })).not.toContain('data-action="clone-offers"');
        let opened = 0;
        act(() => root.render(<Workspace view="home" workspace={workspace} terminals={NO_TERMINALS} rows={[]} deckItems={[]} onAddAgent={noop} offers={{ count: 2, onOpen: () => { opened += 1; } }} />));
        act(() => { (host.querySelector('[data-workspace-dashboard] [data-action="clone-offers"]') as HTMLButtonElement).click(); });
        expect(opened).toBe(1);
    });
});
