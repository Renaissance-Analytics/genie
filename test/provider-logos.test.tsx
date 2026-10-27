import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { ACP_PROVIDERS } from '../src/core/engine.js';
import type { Headroom } from '../src/core/headroom.js';
import type { LiveSession } from '../src/core/roster.js';
import { AgentView } from '../src/renderer/components/AgentView.js';
import { Dashboard, RateLimitPills } from '../src/renderer/components/Dashboard.js';
import { ProvidersBlock } from '../src/renderer/components/FeatureSurfaces.js';
import { MobileShell } from '../src/renderer/components/MobileShell.js';
import { NewAgentView } from '../src/renderer/components/NewAgentModal.js';
import { ProviderLogo, PROVIDER_LOGO_PX } from '../src/renderer/components/ProviderLogo.js';

/**
 * PROVIDER LOGOS, NOT PROVIDER NAMES (genie#1266; the owner, 2026-10-27: "We should be using provider logo icons like genie
 * 1 had everywhere we show the provider. Using the words takes more space than it needs to and forces users to read more.
 * We have enough words and want to reduce all reading to only what is needed.")
 *
 * Genie 1 (v0.7.0-beta.342) drew the vendor's mark from `@particle-academy/fancy-brand-icons` — `AnthropicIcon` for
 * claude, `OpenaiIcon` for codex (renderer/lib/provider-brand.ts, renderer/components/Master/BrandMark.tsx) — and an
 * unknown provider got its INITIAL, never a borrowed logo (AgentAvatarStack's `Face`, AgentTuiSwitcher's `Mark`). The
 * mark is monochrome `currentColor`, so it takes the theme's text colour in light and in dark.
 *
 * Markup claims only (docs/decisions.md D3): which mark, which accessible name, and that the NAME is not visible text.
 */

/** What a person reads: the markup without its tags, so `aria-label` and `title` (hover, screen reader) do not count. */
const visible = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
/** The first element carrying `attr`, through ITS OWN closing tag (nested elements of the same tag are counted). */
const element = (html: string, attr: string) => {
    const at = html.indexOf(attr);
    if (at < 0) return '';
    const start = html.lastIndexOf('<', at);
    const tag = /^<([a-z0-9]+)/i.exec(html.slice(start))?.[1] ?? '';
    const re = new RegExp(`<${tag}\\b|</${tag}>`, 'gi');
    re.lastIndex = start;
    let depth = 0;
    for (let m = re.exec(html); m; m = re.exec(html)) {
        depth += m[0].startsWith('</') ? -1 : 1;
        if (depth === 0) return html.slice(start, m.index + m[0].length);
    }
    return html.slice(start);
};
/** The SVG path each supported provider's mark draws (Simple Icons, CC0, via fancy-brand-icons). */
const MARK_PATH: Record<string, string> = { claude: 'M17.3041 3.541', codex: 'M22.2819 9.8211' };

describe('ProviderLogo', () => {
    it('EVERY provider Genie runs has its real mark (COUNTED against ACP_PROVIDERS, not a spot-check)', () => {
        const drawn = ACP_PROVIDERS.filter((p) => renderToStaticMarkup(<ProviderLogo provider={p} />).includes(`d="${MARK_PATH[p] ?? '∅'}`));
        expect(drawn).toEqual([...ACP_PROVIDERS]);
        // The two marks are different marks: a grid of agents is for telling them apart.
        expect(MARK_PATH.claude).not.toBe(MARK_PATH.codex);
    });

    it('its accessible name is the provider’s name — on hover (title) and to a screen reader (aria-label) — and nothing is read on screen', () => {
        const html = renderToStaticMarkup(<ProviderLogo provider="claude" />);
        expect(html).toMatch(/role="img"/);
        expect(html).toMatch(/aria-label="Claude Code"/);
        expect(html).toMatch(/title="Claude Code"/);
        expect(html).toContain('data-provider-logo="claude"');
        expect(visible(html)).toBe('');
        expect(renderToStaticMarkup(<ProviderLogo provider="codex" />)).toMatch(/aria-label="Codex"[^>]*title="Codex"|title="Codex"[^>]*aria-label="Codex"/);
    });

    it('size variants: xs 12, sm 14 (the default), md 16, lg 20', () => {
        expect(PROVIDER_LOGO_PX).toEqual({ xs: 12, sm: 14, md: 16, lg: 20 });
        expect(renderToStaticMarkup(<ProviderLogo provider="claude" />)).toMatch(/<svg[^>]*width="14"[^>]*height="14"/);
        for (const [size, px] of Object.entries(PROVIDER_LOGO_PX)) {
            expect(renderToStaticMarkup(<ProviderLogo provider="codex" size={size as keyof typeof PROVIDER_LOGO_PX} />)).toMatch(new RegExp(`<svg[^>]*width="${px}"`));
        }
    });

    it('light and dark: the mark is currentColor and its colour is a theme token, never a fixed colour', () => {
        for (const p of ACP_PROVIDERS) {
            const html = renderToStaticMarkup(<ProviderLogo provider={p} />);
            expect(html).toMatch(/<svg[^>]*fill="currentColor"/);
            expect(html).toMatch(/class="[^"]*text-\[var\(--fg-/);
            expect(html).not.toMatch(/fill="#|#[0-9a-f]{3,6}\b|text-(black|white)\b/i);
        }
    });

    it('a provider with no mark (an observed `aider`) gets its INITIAL, as Genie 1 did — never a borrowed logo, never the word', () => {
        const html = renderToStaticMarkup(<ProviderLogo provider="aider" />);
        expect(html).not.toContain('<svg');
        expect(html).toMatch(/aria-label="aider"/);
        expect(visible(html)).toBe('A');
        // CONTROL: a supported provider does draw a mark, so the absence above is not a component that draws none.
        expect(renderToStaticMarkup(<ProviderLogo provider="claude" />)).toContain('<svg');
    });
});

const row = (over: Partial<AgentRow> = {}): AgentRow => ({
    id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working', duration: '12m',
    ask: null, reason: null, fixes: [], step: '4/7', target: 'Passkey enrolment endpoint', activity: null, delivery: null,
    collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over,
});

describe('every place Genie shows a provider wears its logo, not its name', () => {
    it('the Dashboard row: the logo after the name; the word is gone (COUNTED: both rows)', () => {
        const html = renderToStaticMarkup(<Dashboard rows={[row(), row({ id: 'a2', name: 'wren', provider: 'codex' })]} workspaces={[{ id: 'tynn', path: '/w/tynn' }]} onOpenAgent={() => {}} onAddAgent={() => {}} />);
        const a1 = element(html, 'data-agent="a1"');
        expect(a1).toContain('data-provider-logo="claude"');
        expect(visible(a1)).toContain('atlas');
        expect(visible(a1)).not.toMatch(/\bclaude\b/i);
        const a2 = element(html, 'data-agent="a2"');
        expect(a2).toContain('data-provider-logo="codex"');
        expect(visible(a2)).not.toMatch(/\bcodex\b/i);
    });

    it('the rate-limit pills: one logo per provider, then its share left and window', () => {
        const h = (leftPct: number, window: string): Headroom => ({ plan: null, window, leftPct, resetsAtMs: 0, over: false });
        const html = renderToStaticMarkup(<RateLimitPills limits={{ claude: h(80, '5h'), codex: h(97, '7d') }} />);
        expect(html).toMatch(/data-rate-limit="claude"[\s\S]*?data-provider-logo="claude"/);
        expect(html).toMatch(/data-rate-limit="codex"[\s\S]*?data-provider-logo="codex"/);
        expect(visible(html)).toBe('80% 5h 97% 7d');
    });

    const agent = { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn' };
    const running = { running: true, turnState: 'working', startedAt: 0, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, plan: null } as unknown as LiveSession;
    const view = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
        renderToStaticMarkup(<AgentView agent={agent} session={running} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 0} {...props} />);

    it('the Agent view header: the chip is the logo and the engine — `ACP` / `pty` — with no provider word', () => {
        const chip = element(view(), 'data-provider-chip="claude"');
        expect(chip).toContain('data-provider-logo="claude"');
        expect(visible(chip)).toBe('ACP');
        const observed = element(view({ agent: { ...agent, provider: 'aider', fidelity: 'observed' }, session: null }), 'data-provider-chip="aider"');
        expect(observed).toContain('data-provider-logo="aider"');
        expect(visible(observed)).toBe('A pty');
    });

    it('signed out: the header’s login is the logo and `Log in` — the provider is the logo, the sentence is on hover', () => {
        const html = view({ session: { ...running, running: false, turnState: 'idle', signedOut: true } as unknown as LiveSession, onProviderLogin: () => {} });
        const button = element(html, 'data-action="provider-login"');
        expect(button).toContain('data-provider-logo="claude"');
        expect(visible(button)).toBe('Log in');
        expect(button).toMatch(/title="Open the Claude Code login/);
    });

    it('the agent’s Settings: the provider picker leads with the chosen provider’s logo; its options carry logo-and-name as Genie 1’s driver menu did', () => {
        const ops = { mode: 'automated', accessScope: 'self', autoApprove: true, onMode: () => {}, onSetAutoApprove: () => {}, onSwitchDriver: () => {}, onRestart: () => {}, onDelete: () => {} } as never;
        const html = view({ agent: { ...agent, provider: 'codex' }, tab: 'settings', settingsSection: 'general', ops });
        const picker = element(html, 'data-rail="provider"');
        expect(picker).toContain('data-provider-logo="codex"');
        expect(picker).toMatch(/<option value="claude"[^>]*>Claude Code<\/option>/);
        expect(picker).toMatch(/<option value="codex" selected=""[^>]*>Codex<\/option>/);
    });

    it('the New agent form: the chosen provider’s logo beside the picker; options by name (Genie 1’s picker)', () => {
        const html = renderToStaticMarkup(<NewAgentView workspaceName="shop" name="" purpose="" provider="codex" busy={false} error={null} onName={() => {}} onPurpose={() => {}} onProvider={() => {}} onCreate={() => {}} onCancel={() => {}} />);
        expect(html).toContain('data-provider-logo="codex"');
        expect(html).toMatch(/<option value="claude"[^>]*>Claude Code<\/option>/);
        expect(html).toMatch(/<option value="codex"[^>]*>Codex<\/option>/);
    });

    it('Settings → Providers: each row is the logo, then its version and state; no name to read', () => {
        const html = renderToStaticMarkup(<ProvidersBlock providers={[{ provider: 'claude', name: 'Claude Code', installed: true, version: '2.1.0', signedOut: null }, { provider: 'codex', name: 'Codex', installed: false, version: null, signedOut: null }]} onNavigate={() => {}} />);
        const claude = element(html, 'data-provider="claude"');
        expect(claude).toContain('data-provider-logo="claude"');
        expect(visible(claude)).toBe('2.1.0');
        const codex = element(html, 'data-provider="codex"');
        expect(codex).toContain('data-provider-logo="codex"');
        expect(visible(codex)).not.toMatch(/\bcodex\b/i);
        expect(visible(codex)).toContain('not installed');
    });

    it('the phone: an agent row is its name and its logo', () => {
        const html = renderToStaticMarkup(<MobileShell host="alphar" locked={false} refusal={null} items={[]} answering={null} onAnswer={() => {}} onDisconnect={() => {}} agents={{ rows: [row({ id: 'agent_kai', name: 'kai' })], onOpen: () => {} }} />);
        const button = element(html, 'data-mobile-agent="agent_kai"');
        expect(button).toContain('data-provider-logo="claude"');
        expect(visible(button)).toContain('kai');
        expect(visible(button)).not.toMatch(/\bclaude\b/i);
    });
});

/**
 * THE SOURCE GUARD: no renderer component prints a provider value as an element's label. `{row.provider}` alone in a
 * span, or `{agent.provider} · …` as a chip, is the shape every one of the replaced places had. Prose that NAMES a
 * provider inside a sentence (`Asking claude for its models…`) is not this shape and is left alone; so are the tray and
 * OS notifications, which live in main and cannot draw an icon.
 */
const LABEL_SHAPED = />\s*\{\s*[\w$.?!]*\bprovider\s*\}\s*(?:<|·)/;
const LOGIN_TO_NAME = /Log in to \{/;

function tsxUnder(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) tsxUnder(path, out);
        else if (name.endsWith('.tsx')) out.push(path);
    }
    return out;
}
/** Comment lines out (a source guard strips comments BY LINE); the code is what renders. */
const code = (text: string) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\s*\/\*)/.test(l)).join('\n');

describe('the source guard', () => {
    it('CONTROL: the patterns find the shapes they name, so a clean scan means something', () => {
        expect(LABEL_SHAPED.test('<span className="x">{row.provider}</span>')).toBe(true);
        expect(LABEL_SHAPED.test('<span data-provider-chip={agent.provider}>{agent.provider} · {x}</span>')).toBe(true);
        expect(LABEL_SHAPED.test('<span>{detail.agent.provider}</span>')).toBe(true);
        expect(LOGIN_TO_NAME.test('Log in to {providerLogin(agent.provider)?.name}')).toBe(true);
        // …and not prose that names a provider inside a sentence.
        expect(LABEL_SHAPED.test('<p>Asking {agent.provider} for its models…</p>')).toBe(false);
    });

    it('no component under src/renderer prints a provider as a label, or `Log in to <name>`', () => {
        const files = tsxUnder(join('src', 'renderer'));
        expect(files.length).toBeGreaterThan(20);
        const offenders: string[] = [];
        for (const file of files) {
            const text = code(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
            if (LABEL_SHAPED.test(text) || LOGIN_TO_NAME.test(text)) offenders.push(file);
        }
        expect(offenders).toEqual([]);
    });

    it('one table of names: no component keeps its own provider-label table', () => {
        const files = tsxUnder(join('src', 'renderer'));
        expect(files.filter((f) => /PROVIDER_LABEL\b/.test(readFileSync(f, 'utf8')))).toEqual([]);
    });
});
