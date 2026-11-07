import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteRow } from '../src/renderer/components/FeatureSurfaces.js';
import type { FeatureAction, HostedSite } from '../src/renderer/features.js';
import type { SiteInfo } from '../src/main/site-manager.js';
import { registerAppIcons } from '../src/renderer/icons.js';

// The row's icons, as the app registers them (an unregistered name renders an EMPTY span: test/icons.test.ts).
registerAppIcons();

/**
 * EVERY SITE ACTION SHOWS ITS PROGRESS (genie#1393; owner rule: obvious actions and visible progress). A click disables
 * the row's controls at once and the row says the step it is on: restarting / stopping / starting, then waiting for an
 * answer, then still starting (slow), then running (green) or failed (red, with the reason and Retry). Icons, not words:
 * every control is an icon with its name as its label.
 */
const site = (over: Partial<SiteInfo> & Pick<SiteInfo, 'id' | 'host' | 'state'>): HostedSite =>
    ({ name: over.host.replace(/\.gen$/, ''), workspaceId: 'acme', repoPath: '/w/acme', serve: { mode: 'proxy' }, port: 4101, processIds: [over.id], problem: null, ...over }) as HostedSite;
const render = (s: HostedSite, extra: Record<string, unknown> = {}) => renderToStaticMarkup(<SiteRow site={s} editing={null} onAction={() => {}} {...extra} />);
/** Each site control: its action, its label, and whether it is disabled. */
const controls = (html: string) => [...html.matchAll(/<button([^>]*data-site-action="([^"]+)"[^>]*)>/g)].map((m) => ({
    action: m[2]!,
    label: /aria-label="([^"]*)"/.exec(m[1]!)?.[1] ?? null,
    disabled: /\sdisabled=""/.test(m[1]!),
}));
const step = (html: string) => /data-site-step="([^"]*)"/.exec(html)?.[1] ?? null;
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!isValidElement(node)) return [];
    const el = node as ReactElement<Record<string, unknown>>;
    return [el, ...elements(el.props.children as ReactNode)];
}

const running = site({ id: 'site_web', host: 'web.gen', state: 'running' });

describe('the click shows at once', () => {
    it('a pending Restart: the row says "restarting" with a spinner, and EVERY start/stop/restart/retry/open control is disabled', () => {
        const html = render(running, { pending: 'restart' });
        expect(step(html)).toBe('restarting');
        expect(html).toMatch(/data-site-spinner/);
        const lifecycle = controls(html).filter((c) => ['open', 'restart', 'retry', 'stop', 'start'].includes(c.action));
        expect(lifecycle.length).toBeGreaterThan(0);
        expect(lifecycle.every((c) => c.disabled)).toBe(true);
    });

    it('POSITIVE CONTROL: with nothing pending the same row\'s controls are enabled and there is no spinner', () => {
        const html = render(running);
        expect(controls(html).every((c) => !c.disabled)).toBe(true);
        expect(html).not.toMatch(/data-site-spinner/);
        expect(step(html)).toBeNull();
    });

    it('a pending Stop says "stopping"; a pending Start says "starting"', () => {
        expect(step(render(running, { pending: 'stop' }))).toBe('stopping');
        expect(step(render(site({ id: 'site_web', host: 'web.gen', state: 'stopped', processIds: [] }), { pending: 'start' }))).toBe('starting');
    });
});

describe('then the site\'s own progress, from main', () => {
    it('starting, waiting for its first answer: a spinner and the step "answering"', () => {
        const html = render(site({ id: 'site_web', host: 'web.gen', state: 'starting', step: 'answering' } as never));
        expect(step(html)).toBe('answering');
        expect(html).toMatch(/data-site-spinner/);
    });

    it('still starting (slow): still in progress (spinner), NOT red, with Retry and Stop', () => {
        const html = render(site({ id: 'site_web', host: 'web.gen', state: 'starting', step: 'slow' } as never));
        expect(step(html)).toBe('slow');
        expect(html).toMatch(/data-site-spinner/);
        expect(html).not.toMatch(/data-site-status="failed"/);
        expect(controls(html).map((c) => c.action)).toEqual(expect.arrayContaining(['retry', 'stop']));
    });

    it('running: green, no spinner', () => {
        const html = render(running);
        expect(html).toMatch(/data-site-status="running"/);
        expect(html).not.toMatch(/data-site-spinner/);
    });

    it('failed: red, with the reason and Retry', () => {
        const html = render(site({ id: 'site_web', host: 'web.gen', state: 'failed', problem: 'web.gen dev server exited with code 1' }));
        expect(html).toMatch(/data-site-status="failed"/);
        expect(html).toContain('web.gen dev server exited with code 1');
        expect(controls(html).map((c) => c.action)).toContain('retry');
    });

    it('an EXITED dev server is red too, with Retry (consensus.prism.gen showed nothing to press but Start)', () => {
        const html = render(site({ id: 'site_web', host: 'web.gen', state: 'exited', problem: 'web.gen dev server exited with code 0' }));
        expect(html).toMatch(/data-site-status="failed"/);
        expect(controls(html).map((c) => c.action)).toContain('retry');
    });
});

describe('a refused action is said on the row, with Retry', () => {
    it('the refusal\'s reason in red, and Retry sends the SAME action again', () => {
        const action: FeatureAction = { kind: 'hosting.startSite', siteId: 'site_web' };
        const stopped = site({ id: 'site_web', host: 'web.gen', state: 'stopped', processIds: [] });
        const html = render(stopped, { refusal: { action, reason: 'no bundled Caddy' } });
        expect(html).toMatch(/data-site-refusal[^>]*>[^<]*no bundled Caddy/);
        const sent: FeatureAction[] = [];
        const retry = elements(SiteRow({ site: stopped, editing: null, onAction: (a: FeatureAction) => sent.push(a), refusal: { action, reason: 'no bundled Caddy' } } as never)).find((e) => e.props['data-site-action'] === 'retry-refused');
        expect(retry).toBeDefined();
        (retry!.props.onClick as () => void)();
        expect(sent).toEqual([action]);
    });
});

describe('every control is react-fancy\'s Button (owner rule, 2026-11-01)', () => {
    it('each site control, Remove included, is a fancy Button; the one in flight spins (loading) and the rest are disabled', () => {
        const idle = render(running);
        const all = [...idle.matchAll(/<button([^>]*)>/g)].map((m) => m[1]!);
        expect(all.length).toBeGreaterThan(0);
        for (const attrs of all) expect(attrs).toMatch(/data-react-fancy-button/);
        const busy = render(running, { pending: 'restart' });
        const restart = /<button[^>]*data-site-action="restart"[^>]*>([\s\S]*?)<\/button>/.exec(busy)![1]!;
        expect(restart).toMatch(/animate-spin/);
        const stop = /<button[^>]*data-site-action="stop"[^>]*>([\s\S]*?)<\/button>/.exec(busy)![1]!;
        expect(stop).not.toMatch(/animate-spin/);
    });
});

describe('icons over words', () => {
    it('every site control is an icon with its name as its label, and no visible words', () => {
        const html = render(running);
        // Remove stays a worded button inside its confirm: what it does must be read before it is pressed.
        const cs = controls(html).filter((c) => c.action !== 'remove');
        expect(cs.map((c) => c.label)).toEqual(['Open', 'Restart', 'Stop', 'Edit']);
        for (const m of html.matchAll(/<button[^>]*data-site-action="(?!remove")[^"]+"[^>]*>([\s\S]*?)<\/button>/g)) {
            // No text between any two tags: an icon, nothing to read.
            expect(m[1]).not.toMatch(/(^|>)\s*[^<\s][^<]*(<|$)/);
            expect(m[1]).toMatch(/<svg/);
        }
    });
});
