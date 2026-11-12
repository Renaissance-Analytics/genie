// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeckItem, SignalState } from '../src/core/deck.js';
import { Deck } from '../src/renderer/components/Deck.js';
import { QuestionForm } from '../src/renderer/components/QuestionForm.js';

/**
 * THE QUESTION'S OPTIONS ARE FULL-WIDTH CARDS (Tynn #646; the owner, a ForceTheQuestion modal on beta.61: "the FTQ layout
 * is very sloppy still … when I hover, I can't tell what is selected or not"). Seen: each title squeezed into a narrow
 * column and broken letter by letter ("Genie approv al questio n"), the description beside it, rows of different widths,
 * and hover that looked like selection. Now each option is a card as wide as the question: its title bold on a line of its
 * own, never broken inside a word; its description under it, muted; a radio or a check that fills when it is picked, and a
 * border and background that only a pick gives; a hover is a light tint. Arrows move between them, Space and Enter pick,
 * focus is visible. The same form is the Deck's copy (Deck → QuestionForm).
 *
 * jsdom cannot measure, so the layout is asserted on its structure and classes: nothing in it depends on the width (no
 * breakpoint, no width cap on a title), so it is the same at 640 px and at 1366 px.
 */
const QUIET: SignalState = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false } as SignalState;
const LONG = 'Genie approval question';
const questions = [
    { header: 'Where', question: 'Which approval path?', options: [{ label: LONG, description: 'Ask in Genie and wait for the person to answer there.' }, { label: 'Terminal', description: 'Ask in the terminal.' }, { label: 'Skip' }] },
    { header: 'Suites', question: 'Which suites?', options: [{ label: 'unit' }, { label: 'e2e', description: 'The window tests.' }], multiSelect: true },
];
const item: DeckItem = { id: 'q_1', source: 'agent-question', agentId: 'a1', agentName: 'beachhead', workspaceId: 'w', title: 'Where + 1 more', blocking: true, priority: 'normal', at: 1, answer: { kind: 'form', fields: 2, questions }, forwardedFrom: null } as DeckItem;
const form = (initial?: { selections: string[][]; notes: string[] }) => renderToStaticMarkup(<QuestionForm item={item} answering={null} onSubmit={() => {}} {...(initial ? { initial } : {})} />);
const card = (html: string, label: string) => {
    const at = html.indexOf(`data-question-option="${label}"`);
    const start = html.lastIndexOf('<button', at);
    return html.slice(start, html.indexOf('</button>', at) + '</button>'.length);
};
const open = (tag: string) => tag.slice(0, tag.indexOf('>') + 1);

describe('each option is a card as wide as the question', () => {
    it('the options stack in one column, every card full width', () => {
        const html = form();
        const group = html.match(/<div[^>]*role="group"[^>]*aria-label="Where"[^>]*>/)?.[0] ?? '';
        expect(group).toMatch(/\bflex-col\b/);
        expect(group).toMatch(/\bw-full\b/);
        expect(group).not.toMatch(/flex-wrap/);
        for (const label of [LONG, 'Terminal', 'Skip']) expect(open(card(html, label)), label).toMatch(/\bw-full\b/);
    });

    it('the title is bold on its own line, never broken inside a word; the description is under it, muted', () => {
        const c = card(form(), LONG);
        const title = c.match(/<span[^>]*data-option-title=""[^>]*>[^<]*<\/span>/)?.[0] ?? '';
        expect(title).toContain(`>${LONG}<`);
        expect(title).toMatch(/\bblock\b/);
        expect(title).toMatch(/\bfont-semibold\b/);
        expect(title).toMatch(/\bbreak-normal\b/);
        expect(c).not.toMatch(/overflow-wrap:anywhere|break-all/);
        const about = c.match(/<span[^>]*data-option-description=""[^>]*>[^<]*<\/span>/)?.[0] ?? '';
        expect(about).toMatch(/text-\[var\(--fg-3\)\]/);
        expect(c.indexOf('data-option-title')).toBeLessThan(c.indexOf('data-option-description'));
    });

    it('the same at 640 px and at 1366 px: nothing in a card changes with the width', () => {
        const html = form();
        for (const label of [LONG, 'Terminal', 'Skip', 'unit', 'e2e']) {
            const c = card(html, label);
            expect(c, label).not.toMatch(/\b(sm|md|lg|xl|2xl):/);
            expect(c, label).not.toMatch(/max-w-\[|\bw-\d|\bw-\[/);
        }
    });
});

describe('what is picked is unmistakable, and is not what hover looks like', () => {
    it('a radio for a single choice, a check for several; filled when picked', () => {
        const html = form({ selections: [[LONG], ['e2e']], notes: ['', ''] });
        expect(card(html, LONG)).toMatch(/data-option-indicator="radio"[^>]*data-on="true"/);
        expect(card(html, 'Terminal')).toMatch(/data-option-indicator="radio"[^>]*data-on="false"/);
        expect(card(html, 'e2e')).toMatch(/data-option-indicator="checkbox"[^>]*data-on="true"/);
        expect(card(html, 'unit')).toMatch(/data-option-indicator="checkbox"[^>]*data-on="false"/);
    });

    it('picked: the accent border and background; not picked: a plain border, and hover only a light tint', () => {
        const html = form({ selections: [[LONG], []], notes: ['', ''] });
        const on = open(card(html, LONG));
        const off = open(card(html, 'Terminal'));
        expect(on).toContain('aria-pressed="true"');
        expect(on).toMatch(/border-\[var\(--primary\)\]/);
        expect(on).toMatch(/bg-\[color-mix\(in_srgb,var\(--primary\)/);
        expect(off).toContain('aria-pressed="false"');
        expect(off).not.toMatch(/border-\[var\(--primary\)\]/);
        expect(off).toMatch(/hover:bg-\[var\(--bg-2\)\]/);
        expect(off).not.toMatch(/hover:border-\[var\(--primary\)\]|hover:bg-\[color-mix/);
    });

    it('in Genie’s dark theme too: the picked look is not covered by the button’s own dark colours', () => {
        const html = form({ selections: [[LONG], []], notes: ['', ''] });
        const on = open(card(html, LONG));
        const off = open(card(html, 'Terminal'));
        expect(on).toMatch(/dark:border-\[var\(--primary\)\]/);
        expect(on).toMatch(/dark:bg-\[color-mix\(in_srgb,var\(--primary\)/);
        expect(on).not.toMatch(/dark:bg-\[color:var\(--fancy|dark:border-\[color:var\(--fancy/);
        expect(off).toMatch(/dark:hover:bg-\[var\(--bg-2\)\]/);
        expect(off).not.toMatch(/dark:hover:bg-zinc/);
    });

    it('focus is visible on every card', () => {
        for (const label of [LONG, 'unit']) expect(open(card(form(), label)), label).toMatch(/focus-visible:ring-2/);
    });

    it('the Deck’s copy is the same form', () => {
        const html = renderToStaticMarkup(<Deck items={[item]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onAnswerForm={() => {}} />);
        expect(card(html, LONG)).toMatch(/data-option-title=""/);
        expect(card(html, LONG)).toMatch(/data-option-indicator="radio"/);
    });
});

describe('the keyboard', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => { root.unmount(); }); host.remove(); });
    const option = (label: string) => host.querySelector<HTMLButtonElement>(`[data-question-option="${label}"]`)!;
    const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });

    it('one stop per question: the picked card, else the first; arrows move between its cards and wrap', () => {
        act(() => { root.render(<QuestionForm item={item} answering={null} onSubmit={() => {}} initial={{ selections: [['Terminal'], []], notes: ['', ''] }} />); });
        expect(option('Terminal').tabIndex).toBe(0);
        expect(option(LONG).tabIndex).toBe(-1);
        expect(option('unit').tabIndex).toBe(0);
        option('Terminal').focus();
        key(option('Terminal'), 'ArrowDown');
        expect(document.activeElement).toBe(option('Skip'));
        key(option('Skip'), 'ArrowDown');
        expect(document.activeElement).toBe(option(LONG));
        key(option(LONG), 'ArrowUp');
        expect(document.activeElement).toBe(option('Skip'));
        key(option('Skip'), 'Home');
        expect(document.activeElement).toBe(option(LONG));
    });

    it('Space and Enter pick: each card is a button, so the key presses it', () => {
        act(() => { root.render(<QuestionForm item={item} answering={null} onSubmit={() => {}} />); });
        expect(option(LONG).type).toBe('button');
        act(() => { option(LONG).click(); });
        expect(option(LONG).getAttribute('aria-pressed')).toBe('true');
        act(() => { option(LONG).click(); });
        expect(option(LONG).getAttribute('aria-pressed')).toBe('false');
    });
});
