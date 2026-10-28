import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ToolStatus } from '../src/core/toolchain.js';
import { ToolchainSurface, ToolchainUpdateWarning, ToolUpdateActions } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureAction, type FeatureData } from '../src/renderer/features.js';

/**
 * genie#1306 — the owner: "make what I can click on obvious, and make it obvious that something is happening". Every
 * update action is a real button wired to the update it names; the security notice's fix (8.4.27) is the FIRST, primary
 * button and another line (8.5.12) the secondary one; a running update shows its step on its row with the buttons off;
 * it ends updated, or failed with the reason and a Retry; and the "these run on PHP" warning is a count, an expandable
 * list, and one choice.
 */

const PHP: ToolStatus = {
    tool: 'php', installed: '8.4.24', latest: '8.5.12', tone: 'security-update', source: 'php.net releases',
    advisory: 'PHP 8.4.24 is vulnerable to CVE-2026-109618 / CVE-2026-109619 (remote code execution); update to 8.4.27',
    patch: '8.4.27', upgrade: '8.5.12',
};
const GO: ToolStatus = { tool: 'go', installed: '1.25.6', latest: null, tone: 'unknown', source: null, upgrade: '1.27.3' };

const render = (toolchain: FeatureData['toolchain']) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} />);
/** One tool row's markup. */
const row = (html: string, tool: string) => html.slice(html.indexOf(`data-tool="${tool}"`), html.indexOf('</li>', html.indexOf(`data-tool="${tool}"`)));

/** Every element in a tree (without rendering function components), so a button's own onClick can be pressed. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    const out: ReactElement<Record<string, unknown>>[] = [];
    const walk = (n: ReactNode) => Children.forEach(n, (c) => {
        if (!isValidElement(c)) return;
        out.push(c as ReactElement<Record<string, unknown>>);
        walk((c.props as { children?: ReactNode }).children);
    });
    walk(node);
    return out;
}
/** Press the (enabled) button carrying `attr=value`, through its own onClick. */
const press = (tree: ReactElement, attr: string, value: string): void => {
    // A hook-free component renders by calling it: its own output is the tree of buttons.
    const rendered = typeof tree.type === 'function' ? (tree.type as (p: unknown) => ReactNode)(tree.props) : tree;
    const button = elements(rendered).find((e) => e.props[attr] === value);
    expect(button, `${attr}=${value}`).toBeDefined();
    expect(button!.props['disabled']).toBeFalsy();
    (button!.props['onClick'] as () => void)();
};

describe('#1306 — the update actions are real, obvious buttons', () => {
    it('the PHP row: “Update to 8.4.27” is a <button>, FIRST; “8.5.12” is a second, separate button — no underlined text link', () => {
        const html = row(render({ tools: [PHP], checkedAt: 1 }), 'php');
        const patch = html.indexOf('data-version="8.4.27"');
        const upgrade = html.indexOf('data-version="8.5.12"');
        expect(patch).toBeGreaterThan(0);
        expect(upgrade).toBeGreaterThan(patch);
        expect(html).toMatch(/<button[^>]*data-action="toolchain-update"[^>]*data-version="8\.4\.27"/);
        expect(html).toMatch(/<button[^>]*data-action="toolchain-upgrade"[^>]*data-version="8\.5\.12"/);
        expect(html).toContain('Update to 8.4.27');
        expect(html).not.toMatch(/<button[^>]*class="[^"]*underline/);
    });

    it('go with no 1.25 build: one button, to the other line', () => {
        const html = row(render({ tools: [GO], checkedAt: 1 }), 'go');
        expect(html).toMatch(/<button[^>]*data-action="toolchain-update"[^>]*data-version="1\.27\.3"/);
    });

    it('pressing them sends the update FOR THAT VERSION', () => {
        const sent: FeatureAction[] = [];
        const tree = <ToolUpdateActions t={PHP} busy={false} onAction={(a) => sent.push(a)} />;
        press(tree, 'data-version', '8.4.27');
        press(tree, 'data-version', '8.5.12');
        expect(sent).toEqual([{ kind: 'toolchain.update', tool: 'php', version: '8.4.27' }, { kind: 'toolchain.update', tool: 'php', version: '8.5.12' }]);
    });
});

describe('#1306 — it is obvious something is happening, and how it ended', () => {
    it('running: the row shows the step with a spinner, and its buttons are off', () => {
        const html = row(render({ tools: [PHP], checkedAt: 1, updating: { tool: 'php', version: '8.4.27', step: 'Verifying the checksum' } }), 'php');
        expect(html).toContain('data-tool-updating="php"');
        expect(html).toContain('Verifying the checksum');
        expect(html).not.toMatch(/<button(?![^>]*disabled)[^>]*data-action="toolchain-(update|upgrade)"/);
    });

    it('updated: the row says so with the new version', () => {
        const after: ToolStatus = { tool: 'php', installed: '8.4.27', latest: '8.5.12', tone: 'update-available', source: 'php.net releases', upgrade: '8.5.12' };
        const html = row(render({ tools: [after], checkedAt: 1, updated: { tool: 'php', version: '8.4.27' } }), 'php');
        expect(html).toMatch(/data-tool-updated="php"[^>]*>[^<]*8\.4\.27/);
    });

    it('failed: the reason in words and a Retry button that retries the same version', () => {
        const reason = 'PHP 8.4.27 could not be installed: releases.json could not be read (HTTP 503)';
        const html = row(render({ tools: [PHP], checkedAt: 1, refusals: [{ tool: 'php', reason, retry: '8.4.27' }] }), 'php');
        expect(html).toContain(reason);
        expect(html).toMatch(/<button[^>]*data-action="toolchain-retry"[^>]*data-version="8\.4\.27"/);
        const sent: FeatureAction[] = [];
        press(<ToolUpdateActions t={PHP} busy={false} refusal={{ tool: 'php', reason, retry: '8.4.27' }} onAction={(a) => sent.push(a)} />, 'data-action', 'toolchain-retry');
        expect(sent).toEqual([{ kind: 'toolchain.update', tool: 'php', version: '8.4.27' }]);
    });
});

describe('#1306 — the warning: a count, the list behind a toggle, one clear choice', () => {
    const affected = ['flabs.gen dev server', 'moic.gen php worker 2', 'gc.gen php worker', 'prism.gen php worker 4', 'plabs.gen php worker', 'ww.gen php worker', 'flabs queue worker'];
    const warning = { tool: 'php', version: '8.4.27', reason: 'long words', affected };

    it('short: “7 running on PHP”, the names inside a <details>, and two buttons — restart (first) or not', () => {
        const html = render({ tools: [PHP], checkedAt: 1, warning });
        const card = html.slice(html.indexOf('data-toolchain-warning'));
        expect(card).toMatch(/7 running on PHP/);
        expect(card).toMatch(/<details[\s\S]*flabs queue worker[\s\S]*<\/details>/);
        expect(card).not.toContain('long words');
        const restart = card.indexOf('data-action="toolchain-update-restart"');
        const only = card.indexOf('data-action="toolchain-update-only"');
        expect(restart).toBeGreaterThan(0);
        expect(only).toBeGreaterThan(restart);
    });

    it('the buttons send the update, confirmed, with the choice', () => {
        const sent: FeatureAction[] = [];
        const tree = <ToolchainUpdateWarning warning={warning} busy={false} onAction={(a) => sent.push(a)} />;
        press(tree, 'data-action', 'toolchain-update-restart');
        press(tree, 'data-action', 'toolchain-update-only');
        expect(sent).toEqual([
            { kind: 'toolchain.update', tool: 'php', version: '8.4.27', confirmed: true, restart: true },
            { kind: 'toolchain.update', tool: 'php', version: '8.4.27', confirmed: true, restart: false },
        ]);
    });
});
