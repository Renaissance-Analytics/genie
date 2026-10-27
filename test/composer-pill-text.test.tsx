import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * PASTED TEXT GETS ITS PILL, AND THE PILL PREVIEWS IN A POPOVER (beta.35 item 17). The owner (2026-10-20): "Use
 * popovers not tooltips. Pasted text isn't showing me the pill either."
 *
 * 1. The composer held a paste only from 500 characters, so an ordinary paste (a stack trace's top, a few lines of
 *    code, a log excerpt) went in as raw text and no pill ever appeared. Genie's threshold is now its own named
 *    constant, low enough that a few pasted lines are a pill, high enough that a pasted path or sentence is not.
 * 2. The preview: react-fancy 5.51.0 moved the pill's preview from a Tooltip to a Popover (open on hover and on focus,
 *    stays open under the pointer). Genie pinned 5.50.0, so it still drew the tooltip; it is on 5.53.1 now.
 */
const seen = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@particle-academy/react-fancy', async (original) => {
    const real = await original<typeof import('@particle-academy/react-fancy')>();
    const PromptInput = (props: Record<string, unknown>) => { seen.push(props); return (real.PromptInput as unknown as { render: (p: unknown, ref: null) => unknown }).render(props, null); };
    return { ...real, PromptInput };
});
const { ChatFlyout } = await import('../src/renderer/components/ChatFlyout.js');
// Imported lazily: on origin/main the constant does not exist, and a top-level import would fail the file at load.
const composer = () => import('../src/core/composer.js') as Promise<Record<string, unknown>>;

const root = join(import.meta.dirname, '..');
const THREAD = { agentId: 'a_lark', name: 'lark', fidelity: 'declared', unread: null, messages: [] } as never;

const flyoutThreshold = (): unknown => {
    seen.length = 0;
    renderToStaticMarkup(<ChatFlyout thread={THREAD} onSend={() => {}} onClose={() => {}} />);
    return seen.at(-1)?.pasteThreshold;
};

describe('pasted text becomes a pill', () => {
    it('Genie names its threshold, and it sits between a pasted sentence and a few pasted lines', async () => {
        const chars = (await composer()).PASTE_PILL_CHARS;
        expect(typeof chars).toBe('number');
        // A path or a sentence (< 120 characters) stays text; five 60-column lines (300 characters) are a pill.
        expect(chars as number).toBeGreaterThanOrEqual(120);
        expect(chars as number).toBeLessThanOrEqual(300);
    });

    it('the chat composer holds pastes from that threshold, not from 500', async () => {
        const chars = (await composer()).PASTE_PILL_CHARS;
        expect(flyoutThreshold()).toBe(chars);
        expect(flyoutThreshold()).not.toBe(500);
    });
});

describe('the pill previews in a Popover, not a Tooltip', () => {
    const versionOf = (spec: string): number[] => spec.replace(/^[^\d]*/, '').split('.').map(Number);
    const atLeast = (v: number[], min: number[]): boolean => {
        for (let i = 0; i < min.length; i++) { if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i]!; }
        return true;
    };

    it('the gauge: 5.50.0 is below the Popover release and 5.53.1 is not (positive and negative control)', () => {
        expect(atLeast(versionOf('5.50.0'), [5, 51, 0])).toBe(false);
        expect(atLeast(versionOf('5.53.1'), [5, 51, 0])).toBe(true);
    });

    it('package.json and the lockfile pin react-fancy at or above 5.51.0 (the Popover preview), and agree', () => {
        const pinned = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies['@particle-academy/react-fancy'] as string;
        const locked = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages['node_modules/@particle-academy/react-fancy'].version as string;
        expect(atLeast(versionOf(pinned), [5, 51, 0])).toBe(true);
        expect(locked).toBe(pinned.replace(/^[^\d]*/, ''));
    });

    it('the kit actually installed is the Popover release too (a stale node_modules would still draw the tooltip)', () => {
        const installed = JSON.parse(readFileSync(join(root, 'node_modules/@particle-academy/react-fancy/package.json'), 'utf8')).version as string;
        expect(atLeast(versionOf(installed), [5, 51, 0])).toBe(true);
    });
});
