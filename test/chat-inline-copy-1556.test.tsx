// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inlineCopyText } from '../src/core/chat-copy.js';
import { ChatProse } from '../src/renderer/components/ChatProse.js';

/**
 * INLINE CODE AND LINKS COPY ON HOVER (genie#1556, Tynn #439; the owner, 2026-11-04: "stuff like this should be easy to
 * copy with a copy button that appears on hover"). Code blocks, tables and result cards already have their buttons
 * (#1263, #1277); an inline code span — a repository URL, a command — and a link had to be selected by hand.
 *
 * Hovering one shows ONE react-fancy Button, laid over the reply (absolute: the line does not move, the text stays
 * selectable). It copies exactly the code's text, or the link's URL, through Genie's clipboard (renderer/clipboard.ts).
 * happy-dom has no layout (docs/decisions.md D3): where the button sits is not proven here, only that it appears for
 * what it should, copies what it should, and never for what it should not.
 */
const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; genieClipboard?: { write: (text: string, html?: string) => Promise<boolean> } };
let host: HTMLDivElement;
let root: Root;
let written: string[][];
beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    written = [];
    g.genieClipboard = { write: async (...a: [string, string?]) => { written.push(a.filter((x): x is string => x !== undefined)); return true; } };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete g.genieClipboard;
});

const REPLY = 'Clone `git@github.com:acme/app.git`, read [the docs](https://example.com/docs?a=1), then:\n\n```\nnpm ci\n```';
const render = (text = REPLY) => act(() => root.render(<ChatProse text={text} />));
const button = () => host.querySelector<HTMLButtonElement>('[data-copy="inline"], [data-copy="link"]');
const hover = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
const inlineCode = () => [...host.querySelectorAll('code')].find((c) => c.closest('pre') === null)!;

describe('hovering inline code', () => {
    it('shows one copy button, and nothing is shown before the hover', () => {
        render();
        expect(inlineCode()).toBeTruthy();
        expect(button()).toBeNull();
        hover(inlineCode());
        expect(button()?.getAttribute('data-copy')).toBe('inline');
        expect(host.querySelectorAll('[data-copy="inline"], [data-copy="link"]')).toHaveLength(1);
    });

    it('copies exactly the code, nothing around it', async () => {
        render();
        hover(inlineCode());
        await act(async () => { button()!.click(); await new Promise((r) => setTimeout(r, 0)); });
        expect(written).toEqual([['git@github.com:acme/app.git']]);
        expect(button()?.getAttribute('data-copy-state')).toBe('copied');
    });

    it('a failed copy says so', async () => {
        g.genieClipboard = { write: async () => false };
        render();
        hover(inlineCode());
        await act(async () => { button()!.click(); await new Promise((r) => setTimeout(r, 0)); });
        expect(button()?.getAttribute('data-copy-state')).toBe('failed');
    });
});

describe('hovering a link', () => {
    it('copies its URL, not its words', async () => {
        render();
        const link = host.querySelector('a[href^="https://"]')!;
        hover(link);
        expect(button()?.getAttribute('data-copy')).toBe('link');
        await act(async () => { button()!.click(); await new Promise((r) => setTimeout(r, 0)); });
        expect(written).toEqual([['https://example.com/docs?a=1']]);
    });
});

describe('what gets no inline button', () => {
    it('CONTROL: code inside a fenced block is the block’s own button, not this one', () => {
        render();
        hover(host.querySelector('pre code')!);
        expect(button()).toBeNull();
    });

    it('CONTROL: plain words show nothing; leaving the reply hides the button', () => {
        render('Just words here, `and code`.');
        hover(host.querySelector('p')!);
        expect(button()).toBeNull();
        hover(inlineCode());
        expect(button()).not.toBeNull();
        act(() => { host.querySelector('[data-chat-prose]')!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
        expect(button()).toBeNull();
    });
});

describe('what is copied, as a rule', () => {
    it('code: its text exactly; a web or mail link: its URL; a Genie link or empty code: nothing', () => {
        expect(inlineCopyText({ tag: 'code', text: ' npm ci ', href: null, inBlock: false })).toEqual({ kind: 'inline', text: ' npm ci ' });
        expect(inlineCopyText({ tag: 'code', text: 'x', href: null, inBlock: true })).toBeNull();
        expect(inlineCopyText({ tag: 'code', text: '', href: null, inBlock: false })).toBeNull();
        expect(inlineCopyText({ tag: 'a', text: 'docs', href: 'https://example.com/', inBlock: false })).toEqual({ kind: 'link', text: 'https://example.com/' });
        expect(inlineCopyText({ tag: 'a', text: 'me', href: 'mailto:a@b.c', inBlock: false })).toEqual({ kind: 'link', text: 'mailto:a@b.c' });
        expect(inlineCopyText({ tag: 'a', text: 'atlas', href: '#agent:ag_1', inBlock: false })).toBeNull();
        expect(inlineCopyText({ tag: 'a', text: 'f', href: '#file:src/a.ts', inBlock: false })).toBeNull();
    });

    it('the button is a react-fancy Button (ChatProse draws no bare <button>)', () => {
        const src = readFileSync(new URL('../src/renderer/components/ChatProse.tsx', import.meta.url), 'utf8');
        expect(src).not.toMatch(/<button\b/);
        expect(src).toMatch(/InlineCopyButton/);
    });
});
