import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { visibleApprovalText } from '../src/core/approval-text.js';
import type { DeckItem } from '../src/core/deck.js';
import { ApprovalCardView } from '../src/renderer/components/ApprovalCard.js';
import { ApprovalToastStack } from '../src/renderer/components/ApprovalToasts.js';
import { readFileSync } from 'node:fs';

/** What an approval draws: all of its text, wrapped, with blanks counted and unseen characters named. What runs is unchanged. */
const FAR = `echo ok${' '.repeat(400)}& more`;
const OPTIONS = [{ id: 'allow', label: 'Allow', tone: 'ok' as const }];
const words = (text: string) => visibleApprovalText(text).map((part) => part.text).join('');

describe('what is drawn', () => {
    it('an ordinary command is as it was, a double space included', () => {
        expect(visibleApprovalText('npm test  -- --run')).toEqual([{ text: 'npm test  -- --run', named: false }]);
    });

    it('a long run of spaces is said, by count, and what follows it is there', () => {
        const parts = visibleApprovalText(FAR);
        expect(parts).toEqual([{ text: 'echo ok', named: false }, { text: '[400 spaces]', named: true }, { text: '& more', named: false }]);
    });

    it.each([
        ['tabs', 'a\t\t\t\t\tb', '[5 tabs]'],
        ['non-breaking spaces', `a${' '.repeat(9)}b`, '[9 spaces]'],
        ['a mix', `a  \t     b`, '[8 spaces]'],
    ])('%s are the same', (_, text, said) => {
        expect(words(text)).toContain(said);
    });

    it('a line break is shown and kept; a long run of them is said, so padding cannot push the rest out of sight', () => {
        expect(words('a\nb')).toBe('a⏎\nb');
        expect(words(`a${'\n'.repeat(50)}& more`)).toBe('a[50 line breaks]\n& more');
        expect(words('a\r\nb')).toBe('a⏎\nb');
    });

    it.each([
        ['an escape', 'a\u001b[2Kb', '[ESC]'],
        ['a bell', 'a\u0007b', '[U+0007]'],
        ['a lone tab', 'a\tb', '[TAB]'],
        ['a carriage return that overprints', 'safe\revil', '[CR]'],
        ['right-to-left override', 'a‮b', '[U+202E]'],
        ['a direction isolate', 'a⁦b', '[U+2066]'],
        ['a zero-width space', 'a​b', '[U+200B]'],
        ['a byte order mark', 'a﻿b', '[U+FEFF]'],
        ['a C1 control', 'a\u009bb', '[U+009B]'],
        ['a null', 'a\u0000b', '[U+0000]'],
    ])('%s is named', (_, text, said) => {
        const parts = visibleApprovalText(text);
        expect(parts.find((part) => part.named)?.text).toBe(said);
        expect(words(text)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/);
    });

    it('nothing it draws is lost: with the names taken out, the ordinary characters are all there in order', () => {
        const text = `rm  -rf ${' '.repeat(90)}/x\n\n\n\n\n‮& y`;
        const ordinary = visibleApprovalText(text).filter((part) => !part.named).map((part) => part.text).join('').replace(/⏎?\n/g, '');
        expect(ordinary).toBe('rm  -rf/x& y');
    });
});

describe('the approval card, on every screen that uses it', () => {
    const card = (approval: Record<string, unknown>) => renderToStaticMarkup(<ApprovalCardView approval={{ tool: null, options: OPTIONS, ...approval } as never} answering={null} onAnswer={() => {}} note="" onNote={() => {}} />);

    it('a command wraps: it does not scroll sideways, and what was past the edge is on the card', () => {
        const html = card({ question: 'Run a command', command: FAR });
        expect(html).not.toContain('overflow-x-auto');
        expect(html).toMatch(/data-approval-command=""[^>]*whitespace-pre-wrap/);
        expect(html).toMatch(/data-approval-command=""[^>]*\[overflow-wrap:anywhere\]/);
        expect(html).toContain('[400 spaces]');
        expect(html).toContain('&amp; more');
        expect(html).not.toContain(' '.repeat(40));
    });

    it('the question, which is the whole of what the Deck and the phone show, does the same', () => {
        const html = card({ question: `compass wants to open a terminal: ${FAR}` });
        expect(html).toMatch(/data-approval-question[^>]*whitespace-pre-wrap/);
        expect(html).toMatch(/data-approval-question[^>]*\[overflow-wrap:anywhere\]/);
        expect(html).toContain('[400 spaces]');
        expect(html).toContain('&amp; more');
    });

    it('a name stands out from the text around it', () => {
        expect(card({ question: 'x', command: FAR })).toMatch(/data-approval-named=""[^>]*>\[400 spaces\]/);
    });

    it('the Deck, the phone and the chat all draw this card, so a fix here is a fix there', () => {
        for (const file of ['Deck', 'MobileShell', 'ChatFlyout', 'AgentView']) {
            expect(readFileSync(`src/renderer/components/${file}.tsx`, 'utf8'), file).toMatch(/<ApprovalCard\b/);
        }
    });
});

describe('the approval toast', () => {
    it('says the same', () => {
        const item = {
            id: 'appr_1_1', source: 'agent-question', agentId: 'a', agentName: 'compass', workspaceId: 'tynn', title: `compass wants to open a terminal: ${FAR}`,
            blocking: true, priority: 'high', at: 1, answer: { kind: 'inline', options: OPTIONS }, forwardedFrom: null,
        } as unknown as DeckItem;
        const tree = ApprovalToastStack({ view: { ring: [item], front: 0, position: 1, total: 1, answering: [] } as never, notes: {}, onNote: () => {}, onAnswer: () => {}, onLater: () => {}, onFront: () => {}, onEngage: () => {} });
        const stack = (function find(node: ReactNode): Record<string, unknown> | null {
            if (Array.isArray(node)) { for (const n of node) { const hit = find(n); if (hit) return hit; } return null; }
            if (!isValidElement(node)) return null;
            const p = node.props as Record<string, unknown> & { children?: ReactNode };
            return typeof p['renderItem'] === 'function' ? p : find(p.children);
        })(tree);
        const html = renderToStaticMarkup(<>{(stack!['renderItem'] as (i: DeckItem, s: { isFront: boolean }) => ReactNode)(item, { isFront: true })}</>);
        expect(html).toMatch(/data-approval-toast-title=""[^>]*whitespace-pre-wrap/);
        expect(html).toContain('[400 spaces]');
        expect(html).toContain('&amp; more');
    });
});
