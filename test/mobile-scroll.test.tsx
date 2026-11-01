// @vitest-environment happy-dom
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { mobileHtml } from '../src/core/mobile-pwa.js';
import type { AgentDetail } from '../src/renderer/bridge.js';
import { MobileAgent, MobileConnecting, MobileFileView, MobileFiles, MobilePair, MobileShell } from '../src/renderer/components/MobileShell.js';

/**
 * THE PHONE COULD NOT SCROLL (the owner, 2026-11-01, beta.55 over Tailscale: "it won't scroll at all so I am stuck").
 *
 * THE CAUSE: genie#1290 locked the DOCUMENT for the desktop window — `html { overflow: hidden }`, `body, #root
 * { overflow: clip; height: 100% }` (src/renderer/styles.css) — so nothing scrolls unless a pane owns its own scroll.
 * The phone's screens are drawn by the same page and still relied on the document scrolling: the dashboard, the files
 * list, the file viewer and the pairing form were `min-h-dvh` columns with no bounded scroll container inside, so they
 * grew past the screen and were clipped. On a phone there is no wheel and no scrollbar to find: the content below the
 * fold simply did not exist.
 *
 * THE RULE THIS PINS: every phone screen is exactly one dynamic-viewport tall (`h-dvh`, never `min-h-dvh`), clips
 * itself, and owns ONE scroll container that is the bounded flex child (`flex-1 min-h-0 overflow-y-auto`) with its
 * overscroll contained, so a pull at the top is a scroll and not Chrome's pull-to-refresh or iOS rubber-banding the page.
 *
 * Static markup cannot measure layout, so this asserts the STRUCTURE that makes scrolling possible. The pixels — a real
 * touch scroll moving `scrollTop` on an iPhone 13 and a Pixel 7 profile — are proven in the test VM by
 * `MOBILE_PROOF=scroll scripts/mobile-proof/run.sh` (drive-scroll.mjs).
 */

const item = (over: Partial<DeckItem> = {}): DeckItem => ({
    id: 'i1',
    source: 'agent-question',
    agentId: 'agent_w',
    agentName: 'wren',
    workspaceId: 'tynn',
    title: 'Allow php artisan migrate --force?',
    blocking: true,
    priority: 'normal',
    at: 1_760_000_000_000,
    answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }] },
    forwardedFrom: null,
    ...over,
});

const detail: AgentDetail = {
    agent: { id: 'agent_w', name: 'wren', provider: 'claude', fidelity: 'declared', cwd: '/w/tynn' },
    session: { status: 'waiting' } as never,
    rows: [
        { id: 'r1', at: 1, event: { kind: 'message', speaker: 'you', peerName: null, text: 'migrate the db' } },
        { id: 'r2', at: 2, event: { kind: 'message', speaker: 'agent', peerName: null, text: 'Running **migrations** now.' } },
    ] as never,
    turns: 1, cost: null, refusal: null,
};

const noop = () => {};
const SCREENS: Array<[string, ReactElement]> = [
    ['dashboard', <MobileShell host="alphar" locked={false} refusal={null} items={[item()]} answering={null} onAnswer={noop} onDisconnect={noop} workspaces={[{ id: 'tynn', name: 'Tynn' } as never]} selectedWorkspace={null} onSelectWorkspace={noop} onOpenFiles={noop} agents={{ rows: [], onOpen: noop }} />],
    ['agent chat', <MobileAgent detail={detail} sending={false} onBack={noop} onSend={noop} onStart={noop} onResumeLimit={noop} needs={[item(), item({ id: 'i2' })]} answering={null} onAnswer={noop} />],
    ['agent chat (loading)', <MobileAgent detail={null} sending={false} onBack={noop} onSend={noop} onStart={noop} onResumeLimit={noop} />],
    ['files list', <MobileFiles workspaceName="Tynn" path="docs" entries={[{ id: 'docs/a.md', label: 'a.md', type: 'file', ext: 'md' }]} onOpen={noop} onUp={noop} onUpload={noop} uploading={false} outcome={null} onBack={noop} />],
    ['file viewer', <MobileFileView path="docs/a.md" preview={{ kind: 'text', text: 'line\n'.repeat(500) }} onBack={noop} />],
    ['pairing', <MobilePair host="alphar.tailnet.ts.net:7421" refusal={null} connecting={false} onConnect={noop} />],
    ['connecting', <MobileConnecting host="alphar" />],
];

const parse = (el: ReactElement): Element => {
    const doc = new DOMParser().parseFromString(`<body>${renderToStaticMarkup(el)}</body>`, 'text/html');
    return doc.body.firstElementChild as Element;
};
const classes = (el: Element): Set<string> => new Set((el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));

describe('every phone screen scrolls inside itself (the document is locked by genie#1290)', () => {
    it('premise: the document itself never scrolls — so a screen that relies on it cannot scroll at all', () => {
        const css = readFileSync(join(__dirname, '../src/renderer/styles.css'), 'utf8');
        expect(css).toMatch(/html\s*\{\s*overflow:\s*hidden;/);
    });

    for (const [name, el] of SCREENS) {
        it(`${name}: one dynamic viewport tall and clipped, never min-h-dvh (which grows past the screen and is clipped by #root)`, () => {
            const root = parse(el);
            const c = classes(root);
            expect(c.has('min-h-dvh'), `${name} root: ${[...c].join(' ')}`).toBe(false);
            expect(c.has('h-dvh'), `${name} root: ${[...c].join(' ')}`).toBe(true);
            expect(c.has('overflow-hidden'), `${name} root: ${[...c].join(' ')}`).toBe(true);
            expect(c.has('flex') && c.has('flex-col'), `${name} root: ${[...c].join(' ')}`).toBe(true);
        });

        it(`${name}: owns exactly one scroll container, the bounded flex child, with overscroll contained and momentum`, () => {
            const root = parse(el);
            const scrollers = [...root.querySelectorAll('[data-mobile-scroll]')];
            expect(scrollers, `${name}: [data-mobile-scroll] count`).toHaveLength(1);
            const s = scrollers[0]!;
            const c = classes(s);
            for (const k of ['flex-1', 'min-h-0', 'overflow-y-auto', 'overscroll-contain', 'touch-pan-y']) expect(c.has(k), `${name} scroller lacks ${k}: ${[...c].join(' ')}`).toBe(true);
            // A DIRECT child of the screen's column: a scroller nested in an unbounded wrapper never gets a height.
            expect(s.parentElement, `${name}: scroller must be a direct child of the screen root`).toBe(root);
        });
    }

    it('agent chat: what waits on you scrolls in its own capped strip, so a pile of approvals never pushes the composer off the screen', () => {
        const root = parse(SCREENS[1]![1]);
        const waiting = root.querySelector('[data-mobile-waiting]');
        expect(waiting).not.toBeNull();
        const c = classes(waiting!);
        expect(c.has('overflow-y-auto') && c.has('overscroll-contain') && c.has('shrink-0'), [...c].join(' ')).toBe(true);
        expect([...c].some((k) => /^max-h-\[\d+dvh\]$/.test(k)), [...c].join(' ')).toBe(true);
        // The composer never shrinks away.
        const footer = root.querySelector('footer');
        expect(classes(footer!).has('shrink-0')).toBe(true);
    });
});

describe('nothing swallows the touch', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(n) ? [p] : [];
    });
    const renderer = files(join(__dirname, '../src/renderer'));

    it('control: the walk sees the renderer (MobileShell and styles.css among its files)', () => {
        expect(renderer.some((p) => p.endsWith('MobileShell.tsx'))).toBe(true);
        expect(renderer.some((p) => p.endsWith('styles.css'))).toBe(true);
    });

    it('no touchmove listener anywhere in the renderer (a preventDefault in one kills every scroll on the phone)', () => {
        const offenders = renderer.filter((p) => /touchmove|onTouchMove/.test(readFileSync(p, 'utf8')));
        expect(offenders).toEqual([]);
    });

    it('no touch-action: none on html, body or #root', () => {
        const css = readFileSync(join(__dirname, '../src/renderer/styles.css'), 'utf8');
        const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
        const bad = rules.filter(([, sel, body]) => /(^|[\s,])(html|body|#root)\b/.test(sel!) && /touch-action:\s*none/.test(body!));
        expect(bad.map((r) => r[1]!.trim())).toEqual([]);
    });

    it('the phone page sizes for the on-screen keyboard: interactive-widget=resizes-content, so dvh shrinks and the composer stays above it', () => {
        const html = mobileHtml('<html><head><title>Genie</title></head><body></body></html>', 'alphar');
        const meta = /<meta name="viewport" content="([^"]+)"/.exec(html)?.[1] ?? '';
        expect(meta).toContain('width=device-width');
        expect(meta).toContain('viewport-fit=cover');
        expect(meta).toContain('interactive-widget=resizes-content');
    });
});
