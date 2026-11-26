import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ToolStatus } from '../src/core/toolchain.js';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { installNote, plainRefusal } from '../src/renderer/toolchain-view.js';

/**
 * Tynn #1062 — THE TOOLCHAIN, USABLE (the owner's beta.66 screenshot, Windows, a ~1050 px window with the chat open:
 * "barely usable"). One title; the panel only when a tool is chosen; plain words instead of paths, registry keys, stars
 * and "no password"; every action a button that names what it does. The layout itself is proved by screenshots
 * (scripts/toolchain-shots-cdp.mjs); this file holds the words and the structure.
 */
type Tc = NonNullable<FeatureData['toolchain']>;
const t = (tool: string, installed: string | null, tone: ToolStatus['tone'], extra: Partial<ToolStatus> = {}): ToolStatus => ({ tool, installed, latest: null, tone, source: null, ...extra });
const HOME_DIR = 'C:\\Users\\someone\\.genie\\toolchain\\php\\8.4.27';
const DEFAULTS = { php: '8.4.27', node: null, go: null, python: null, dotnet: null, rust: null, ruby: null, java: null } as const;
/** The owner's machine, as his screenshot showed it. */
const OWNER: Tc = {
    tools: [t('git', '2.52.0', 'up-to-date'), t('docker', null, 'not-installed')],
    checkedAt: 1,
    installs: { docker: { label: 'winget install Docker.DockerDesktop', elevated: true } },
    php: {
        managed: [
            { version: '8.4.27', dir: HOME_DIR, usedBy: ['a.gen', 'b.gen'] },
            { version: '8.3.26', dir: 'C:\\Users\\someone\\.genie\\toolchain\\php\\8.3.26', usedBy: ['tynn.gen'] },
        ],
        system: null,
        available: [{ version: '8.4.27', installed: true }, { version: '8.5.2', installed: false }],
    },
    python: { managed: [], system: { version: '3.13.15' }, available: [{ version: '3.15.1', installed: false }] },
    defaults: DEFAULTS,
    machinePath: {
        applied: true,
        where: ['the user PATH (HKCU\\Environment)'],
        entries: ['C:\\Users\\someone\\.genie\\toolchain\\shims'],
        targets: ['the user PATH (HKCU\\Environment)'],
    },
};
const render = (toolchain: Tc | null, selected?: string) =>
    renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} {...(selected ? { selected } : {})} />);
/** What a person READS: the markup's text, attributes (titles, data-*) left out. */
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const card = (html: string, key: string) => {
    const at = html.indexOf(`data-tool-card="${key}"`);
    return at < 0 ? '' : html.slice(at, html.indexOf('</li>', at));
};
const panel = (html: string) => {
    const at = html.indexOf('data-toolchain-panel=');
    return at < 0 ? '' : html.slice(at);
};

describe('#1062 — one title', () => {
    it('the Toolchain draws no title of its own: Settings already says "Toolchain" above it', () => {
        const html = render(OWNER);
        expect(html).not.toMatch(/<h1[^>]*>\s*Toolchain\s*</);
        // CONTROL: its controls are still there, in its toolbar.
        expect(html).toContain('data-action="toolchain-check-updates"');
        expect(html).toContain('Check and repair');
    });
});

describe('#1062 — the panel only when a tool is chosen', () => {
    it('nothing chosen: the cards have the room, no panel is drawn', () => {
        expect(render(OWNER)).not.toContain('data-toolchain-panel=');
    });
    it('chosen: its panel, with a Back button that names where it goes', () => {
        const html = render(OWNER, 'php');
        expect(html).toContain('data-toolchain-panel="php"');
        expect(text(panel(html))).toMatch(/All tools/);
        expect(html).toContain('data-panel-close');
    });
});

describe('#1062 — the panel says where a version comes from in words, never a path', () => {
    it('Genie’s copy, the default; the folder only behind a copy button', () => {
        const p = panel(render(OWNER, 'php'));
        const words = text(p);
        expect(words).toMatch(/8\.4\.27/);
        expect(words).toMatch(/Installed by Genie/);
        expect(words).not.toMatch(/Users|someone|\.genie|→/);
        expect(p).toMatch(/data-copy-path=""[^>]*aria-label="Copy the folder it is in"|aria-label="Copy the folder it is in"[^>]*data-copy-path=""/);
    });
    it('the system’s copy says so', () => {
        const words = text(panel(render(OWNER, 'python')));
        expect(words).toMatch(/3\.13\.15/);
        expect(words).toMatch(/On your system/);
    });
    it('no "means everywhere" jargon: the heading says what the choice does', () => {
        const words = text(panel(render(OWNER, 'php')));
        expect(words).not.toMatch(/means everywhere/);
        // One casing, the section-heading style: the language's name, not its command.
        expect(words).toMatch(/Which version PHP runs/);
    });
    it('a pinned version is "Used by 2 sites", its Remove a button that names the version', () => {
        const p = panel(render(OWNER, 'php'));
        expect(text(p)).toMatch(/Used by 2 sites/);
        expect(text(p)).toMatch(/Used by tynn\.gen/);
        expect(p).toMatch(/aria-label="Remove PHP 8\.3\.26"/);
    });
});

describe('#1062 — "other terminals" in plain words, with a button that names what it does', () => {
    it('on: says it, and the button turns it off by name; no registry key, no path, no bare Undo', () => {
        const html = render(OWNER);
        const at = html.indexOf('data-machine-path=');
        const mp = html.slice(at, html.indexOf('</section>', at));
        const words = text(mp);
        expect(mp).toContain('data-machine-path="on"');
        expect(words).toMatch(/Terminals outside Genie use these versions too/);
        expect(words).not.toMatch(/HKCU|Environment|Users|\bUndo\b/);
        expect(mp).toMatch(/data-machine-path-undo=""[^>]*>[^]*?Stop using them outside Genie/);
    });
    it('off: says what it would do, the paths only in its tooltip', () => {
        const html = render({ ...OWNER, machinePath: { ...OWNER.machinePath!, applied: false, where: [] } });
        const at = html.indexOf('data-machine-path=');
        const mp = html.slice(at, html.indexOf('</section>', at));
        expect(mp).toContain('data-machine-path="off"');
        expect(text(mp)).not.toMatch(/HKCU|Users|shims/);
        expect(mp).toMatch(/data-machine-path-apply=""[^>]*>[^]*?Use them outside Genie too/);
    });
});

describe('#1062 — no "no password" noise; a password is a lock, named', () => {
    it('Genie’s own installs say nothing about passwords', () => {
        const html = render(OWNER, 'php');
        expect(text(html)).not.toMatch(/no password/i);
        expect(installNote({ label: 'x', elevated: false })).toBeNull();
    });
    it('an install that asks shows a lock, named for a screen reader and on hover — not the words "asks once"', () => {
        const docker = card(render(OWNER), 'docker');
        expect(docker).toMatch(/data-install-note="docker"[^>]*title="Asks for your password"/);
        expect(text(docker)).not.toMatch(/asks once/);
    });
});

describe('#1062 — what a card is using, in words: Default or System', () => {
    it('PHP: 8.4.27, Genie’s default, said as "Default" — no star', () => {
        const php = card(render(OWNER), 'php');
        expect(php).toMatch(/data-in-use="php"[^>]*data-in-use-kind="default"/);
        expect(text(php)).toMatch(/8\.4\.27 Default/);
        expect(php).not.toContain('★');
        expect(text(php)).toMatch(/Also 8\.3\.26/);
    });
    it('Python: the system copy said ONCE, as "System"; one action that says it installs Genie’s copy', () => {
        const py = card(render(OWNER), 'python');
        const words = text(py);
        expect(py).toMatch(/data-in-use="python"[^>]*data-in-use-kind="system"/);
        expect(words.match(/3\.13\.15/g)).toHaveLength(1);
        expect(words).toMatch(/System/);
        expect(words).not.toMatch(/system 3\.13\.15/);
        expect(py).toMatch(/data-card-primary="install"[^>]*data-version="3\.15\.1"/);
        expect(words).toMatch(/Install Genie's 3\.15\.1/);
    });
    it('"Versions" is a button, not a ghost word (its look is proved by the screenshots)', () => {
        const php = card(render({ ...OWNER, php: { ...OWNER.php!, available: [] } }), 'php');
        expect(php).toMatch(/<button[^>]*data-open-panel="php"[^>]*>[^]*?Versions</);
    });
});

describe('#1062 — the tallies are one compact line', () => {
    it('three counts in one row, no big numbers', () => {
        const html = render(OWNER);
        const at = html.indexOf('data-toolchain-tallies');
        const tallies = html.slice(at, html.indexOf('</div>', at));
        expect(tallies).not.toMatch(/text-xl|<br/);
        expect(text(tallies)).toMatch(/\d+ ready/);
        expect(text(tallies)).toMatch(/\d+ need you/);
    });
});

const STALE = "windows.php.net's current PHP 8.5 build is 8.5.13, not 8.5.12; an archived build has no published checksum, so Genie will not install PHP 8.5.12 unverified. Nothing was downloaded";

describe('#1062 — a refusal in plain words, its detail behind "Details", its way out a button', () => {
    it('a version no longer offered: says so, and names the one to install instead', () => {
        expect(plainRefusal(STALE)).toEqual({ text: "PHP 8.5.12 isn't available any more.", install: '8.5.13', details: STALE });
    });
    it('a version that is not installed: says so', () => {
        const reason = 'PHP 8.5.12 is not a version Genie manages here; install it in Toolchain first';
        expect(plainRefusal(reason)).toEqual({ text: "PHP 8.5.12 isn't installed.", details: reason });
    });
    it('a short reason is said as it is, with no Details; a long one is cut at its first clause', () => {
        expect(plainRefusal('PHP 8.4.26 is pinned by shop.gen')).toEqual({ text: 'PHP 8.4.26 is pinned by shop.gen' });
        const long = 'installing php with pacman would also upgrade icu 77.1-1 to 78.1-1, which other packages need; nothing was changed and you can retry once it is updated';
        expect(plainRefusal(long)).toEqual({ text: 'installing php with pacman would also upgrade icu 77.1-1 to 78.1-1, which other packages need.', details: long });
    });
    it('the panel: the plain line, an Install button for the offered version, the engine words only under Details', () => {
        const html = render({ ...OWNER, refusals: [{ tool: 'php', version: '8.5.12', reason: STALE }] }, 'php');
        const p = panel(html);
        expect(p).toMatch(/data-php-refusal="8\.5\.12"/);
        expect(text(p)).toMatch(/PHP 8\.5\.12 isn't available any more\./);
        expect(p).toMatch(/<button[^>]*data-refusal-install="8\.5\.13"[^>]*>[^]*?Install 8\.5\.13</);
        expect(p).toMatch(/<details[^>]*>[^]*?Details[^]*?archived build has no published checksum/);
    });
});

describe('#1062 — the problems collapse to one row on a narrow page', () => {
    it('a summary row ("3 need you": two CLIs and Docker) with a button that shows them; the rows and their Repair stay in the page', () => {
        const html = render({ ...OWNER, tools: [...OWNER.tools, t('claude-code', '2.1.0', 'broken', { problem: 'npm skipped its setup step' }), t('codex', '0.71.0', 'broken', { problem: 'no codex program' })] });
        expect(html).toMatch(/data-problems-summary="3"[^>]*>[^]*?3 need you/);
        expect(html).toMatch(/<button[^>]*data-problems-toggle=""[^>]*aria-expanded="false"|<button[^>]*aria-expanded="false"[^>]*data-problems-toggle=""/);
        expect((html.match(/data-problem-action=/g) ?? []).length).toBe(3);
    });
});

describe('#1062 — the narrow list, as the coordinator reviewed it (1050x720)', () => {
    it('a tool that is not on the machine says "Not installed", never "not here"', () => {
        const docker = card(render(OWNER), 'docker');
        expect(text(docker)).toMatch(/Not installed/);
        expect(text(render(OWNER))).not.toMatch(/not here/i);
    });
    it('the status mark has no place in the narrow row (the tallies say it): drawn only with room', () => {
        const git = card(render(OWNER), 'git');
        expect(git).toMatch(/data-card-status="ok"[^>]*class="[^"]*\bhidden\b[^"]*@min-\[440px\]:grid/);
    });
    it('the folded problems row names no tools, so nothing in it is cut off', () => {
        const html = render({ ...OWNER, tools: [...OWNER.tools, t('codex', '0.71.0', 'broken', { problem: 'no codex program' })] });
        const at = html.indexOf('data-problems-summary=');
        const summary = html.slice(at, html.indexOf('</button>', at));
        expect(text(summary)).not.toMatch(/Codex|Docker/);
        expect(text(summary)).toMatch(/2 need you/);
    });
});
