import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HEADER_REPOS_INLINE, headerRepos } from '../src/core/repo-status.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';

/**
 * THE WORKSPACE HEADER FITS ITS COLUMN (beta.33 item 23). The owner (2026-10-20, screenshot): "why the fuck is any
 * content at all behind the fucking chat panel?" The header drew the name, the path and ONE CHIP PER REPO in a single
 * row that could not wrap, every chip `shrink-0`: an envelope with many repos made the row wider than the page column,
 * and `<main>` clipped it at the chat's left edge — content "behind the chat", and a page that scrolled sideways.
 *
 * Now: a few chips in the row (a locked repo always among them), the rest behind "+N more" in a Fancy Popover — every
 * repo still one click away — and the row wraps rather than ever overflowing its column.
 */
const repo = (slug: string, lock: { heldSince: number; stale: boolean } | null = null) => ({ name: slug, slug, path: slug === 'tynn' ? '.' : `repos/${slug}`, host: slug === 'tynn', branch: 'main', lock });
const twelve = ['tynn', 'genie', 'tynn-claude-tooling', 'tynn-mcp-testing', 'shared-schemas', 'api', 'web', 'docs', 'cli', 'infra', 'design', 'marketing'].map((s) => repo(s));
const ops = (list: ReturnType<typeof repo>[]): WorkspaceOpsProps => ({
    asleep: false, agentCount: 0, lastOutcome: null, removePreview: false,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    repos: { list, onAdd: () => {}, onRemove: () => {}, onOpen: () => {}, onRemoveLock: () => {} },
});
const render = (list: ReturnType<typeof repo>[]) => renderToStaticMarkup(<Workspace view="home" workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} terminals={NO_TERMINALS} ops={ops(list)} />);
const header = (html: string) => html.slice(html.indexOf('data-view-header'), html.indexOf('</header>'));

describe('which repos sit in the row, and which behind "+N more"', () => {
    it('every repo is reachable: the row and the rest together are ALL of them, each once (COUNTED)', () => {
        const { inline, more } = headerRepos(twelve);
        expect(inline).toHaveLength(HEADER_REPOS_INLINE);
        expect(inline.length + more.length).toBe(12);
        expect(new Set([...inline, ...more].map((r) => r.slug)).size).toBe(12);
    });

    it('a LOCKED repo is always in the row, wherever it is in the list — a problem is never behind a click', () => {
        const list = twelve.map((r) => (r.slug === 'marketing' ? repo('marketing', { heldSince: 1, stale: true }) : r));
        expect(headerRepos(list).inline.map((r) => r.slug)).toContain('marketing');
        expect(headerRepos(list).more.map((r) => r.slug)).not.toContain('marketing');
    });

    it('CONTROL: few repos — all in the row, nothing behind "+N more"', () => {
        const few = twelve.slice(0, HEADER_REPOS_INLINE);
        expect(headerRepos(few).more).toEqual([]);
        expect(headerRepos(few).inline).toHaveLength(HEADER_REPOS_INLINE);
    });
});

describe('the header, drawn', () => {
    it(`twelve repos: ${HEADER_REPOS_INLINE} chips in the row and a "+N more" for the rest — not twelve chips in one row`, () => {
        const h = header(render(twelve));
        expect((h.match(/data-repo-chip="/g) ?? []).length).toBe(HEADER_REPOS_INLINE);
        expect(h).toMatch(new RegExp(`data-action="more-repos"[\\s\\S]*?\\+${12 - HEADER_REPOS_INLINE} more`));
    });

    it('the row WRAPS instead of overflowing, and the path gives way before anything else', () => {
        const h = header(render(twelve));
        expect(h).toMatch(/^data-view-header="" class="[^"]*\bflex-wrap\b/);
        // Not pinned to one 56px line any more: it may grow a second line rather than spill sideways.
        expect(h).not.toMatch(/^data-view-header="" class="[^"]*(?<!min-)\bh-14\b/);
        expect(h).toMatch(/class="[^"]*\btruncate\b[^"]*"[^>]*>\/w\/tynn</);
    });

    it('CONTROL: one repo — its chip, and no "+N more"', () => {
        const h = header(render([repo('tynn')]));
        expect((h.match(/data-repo-chip="/g) ?? []).length).toBe(1);
        expect(h).not.toContain('more-repos');
    });
});
