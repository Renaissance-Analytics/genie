import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ToolStatus } from '../src/core/toolchain.js';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { ToolLogo } from '../src/renderer/components/ToolLogo.js';
import { EMPTY_FEATURES, type FeatureAction, type FeatureData } from '../src/renderer/features.js';
import { cardOfAction, formatElapsed, installNote, nextFix, toolchainActivity, toolchainCards, toolchainProblems, toolchainTally } from '../src/renderer/toolchain-view.js';

/**
 * Tynn #962 — THE TOOLCHAIN VIEW AS THE OWNER APPROVED IT (ArtBoard 958-toolchain-redesign, 2026-11-20; mockup
 * .ai/sandbox/958-toolchain-mockup.html): a problems strip with one button per problem, logo cards grouped by type with ONE
 * primary action each, progress on the card itself with the rest of the page still usable, a side panel per tool (the
 * default as a radio, the system copy, the sites pinned, Install another version), an activity feed, and no raw shell
 * command anywhere — an install that asks for the password shows a lock (Tynn #1062). UI only: every button sends an action
 * that already exists.
 */
type Tc = NonNullable<FeatureData['toolchain']>;
const t = (tool: string, installed: string | null, tone: ToolStatus['tone'], extra: Partial<ToolStatus> = {}): ToolStatus => ({ tool, installed, latest: null, tone, source: null, ...extra });
const DEFAULTS = { php: '8.4.11', node: '24.11.1', go: null, python: null, dotnet: null, rust: null, ruby: null, java: null } as const;
const SCENE: Tc = {
    tools: [
        t('php', '8.4.11', 'security-update'),
        t('node', '24.11.1', 'update-available', { latest: '24.12.0' }),
        t('go', '1.26.6', 'up-to-date'),
        t('composer', '2.9.1', 'up-to-date'),
        t('git', '2.52.0', 'update-available', { latest: '2.53.0' }),
        t('docker', null, 'not-installed'),
        t('claude-code', '2.3.4', 'unknown'),
        t('codex', '0.71.0', 'unknown', { signedOut: true }),
    ],
    checkedAt: 1,
    installs: { docker: { label: 'pacman -S docker && usermod -aG docker you', elevated: true } },
    php: {
        managed: [
            { version: '8.4.11', dir: '/t/php/8.4.11', usedBy: ['a.gen', 'b.gen', 'c.gen'], advisory: 'PHP 8.4.11 is vulnerable to CVE-2026-4417; update to 8.4.27' },
            { version: '8.3.26', dir: '/t/php/8.3.26', usedBy: ['tynn.gen'] },
        ],
        system: { version: '8.4.14' },
        available: [{ version: '8.4.27', installed: false }, { version: '8.5.2', installed: false }, { version: '8.3.26', installed: true }],
    },
    node: { managed: [{ version: '24.11.1', dir: '/t/node/24.11.1' }, { version: '22.23.2', dir: '/t/node/22.23.2' }], system: null, available: [{ version: '24.12.0', installed: false }] },
    java: { managed: [], system: null, available: [{ version: '21.0.9+10', line: 21, installed: false }, { version: '25.0.1+8', line: 25, installed: false }] },
    defaults: DEFAULTS,
};
const render = (toolchain: Tc | null, selected?: string) =>
    renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} {...(selected ? { selected } : {})} />);
/** One card's markup: from its `data-tool-card` to the end of its `<li>`. */
const card = (html: string, key: string) => {
    const at = html.indexOf(`data-tool-card="${key}"`);
    return at < 0 ? '' : html.slice(at, html.indexOf('</li>', at));
};

describe('#962 — the problems strip: one row and ONE button per problem', () => {
    it('names each problem with the action that fixes it — the security fix, Docker missing, the signed-out CLI (COUNTED: three)', () => {
        const problems = toolchainProblems(SCENE);
        expect(problems.map((p) => p.key)).toEqual(['php:8.4.11', 'docker', 'codex']);
        expect(problems[0]).toMatchObject({ card: 'php', label: 'Install 8.4.27', action: { kind: 'toolchain.installPhp', version: '8.4.27', consent: true } });
        expect(problems[0]!.why).toMatch(/CVE-2026-4417/);
        expect(problems[0]!.why).toMatch(/3 sites run on it/);
        expect(problems[1]).toMatchObject({ card: 'docker', label: 'Install Docker', note: 'asks once', action: { kind: 'toolchain.install', tool: 'docker', consent: true } });
        expect(problems[2]).toMatchObject({ card: 'codex', label: 'Log in', action: { kind: 'toolchain.login', tool: 'codex' } });
    });

    it('the strip draws them, a button each, and never the raw command', () => {
        const html = render(SCENE);
        expect(html).toContain('data-toolchain-problems="3"');
        expect((html.match(/data-problem-action=/g) ?? [])).toHaveLength(3);
        expect(html).not.toMatch(/>[^<]*pacman -S docker/);
        expect(html).toMatch(/data-problem="docker"[^]*?data-problem-note="docker"[^>]*title="Asks for your password"/);
    });

    it('a broken CLI is a problem with Repair; a needs-install finding with Install', () => {
        const p = toolchainProblems({
            tools: [t('claude-code', '2.1.0', 'broken', { problem: 'npm skipped its setup step' })], checkedAt: 1,
            findings: [{ kind: 'vc-runtime', missing: ['msvcp140.dll'], result: { kind: 'needs-install', tool: 'vcredist', reason: 'PHP cannot start without msvcp140.dll.' } }],
        });
        expect(p.map((x) => x.action)).toEqual([{ kind: 'toolchain.repairCli', tool: 'claude-code' }, { kind: 'toolchain.install', tool: 'vcredist', consent: true }]);
    });

    it('CONTROL: a healthy machine has no strip at all', () => {
        const healthy: Tc = { tools: [t('git', '2.52.0', 'up-to-date')], checkedAt: 1 };
        expect(toolchainProblems(healthy)).toEqual([]);
        expect(render(healthy)).not.toContain('data-toolchain-problems');
    });

    it('"Fix 3 problems" sends them ONE AT A TIME, waiting while anything runs, and stops on a warning or a refusal', () => {
        const queue = toolchainProblems(SCENE).map((p) => p.action!) as FeatureAction[];
        expect(render(SCENE)).toMatch(/data-action="toolchain-fix-all"[^>]*>[^]*?Fix 3 problems/);
        const first = nextFix(queue, SCENE);
        expect(first.send).toEqual(queue[0]);
        expect(first.rest).toEqual(queue.slice(1));
        expect(nextFix(first.rest, { ...SCENE, busy: 'Installing PHP 8.4.27' })).toEqual({ send: null, rest: first.rest });
        expect(nextFix(first.rest, { ...SCENE, updating: { tool: 'php', step: 'Downloading' } }).send).toBeNull();
        expect(nextFix(first.rest, { ...SCENE, warning: { tool: 'docker', reason: 'r', affected: [] } })).toEqual({ send: null, rest: [] });
        expect(nextFix(first.rest, { ...SCENE, refusals: [{ tool: 'php', version: '8.4.27', reason: 'no' }] })).toEqual({ send: null, rest: [] });
    });
});

describe('#962 — the tallies', () => {
    it('ready, updates (with how many are security), need you', () => {
        const tally = toolchainTally(toolchainCards(SCENE), toolchainProblems(SCENE));
        // ready: go, composer, claude-code; updates: node, git; need you: the three problems; php's security is one.
        expect(tally).toEqual({ ready: 3, updates: 2, security: 1, needYou: 3 });
        const html = render(SCENE);
        expect(html).toMatch(/data-tally="ready"[^]*?>3</);
        expect(html).toMatch(/data-tally="need-you"[^]*?>3</);
    });
});

describe('#962 — logo cards grouped by type, ONE primary action each', () => {
    it('three groups in the approved order: Languages; Package managers · Version control · Containers; Agent CLIs · Browsers', () => {
        const groups = toolchainCards(SCENE);
        expect(groups.map((g) => g.group)).toEqual(['languages', 'tools', 'agents']);
        expect(groups[0]!.cards.map((c) => c.key)).toEqual(['php', 'node', 'go', 'java']);
        expect(groups[1]!.cards.map((c) => c.key)).toEqual(['composer', 'git', 'docker']);
        expect(groups[2]!.cards.map((c) => c.key)).toEqual(['claude-code', 'codex']);
        const html = render(SCENE);
        expect([...html.matchAll(/data-card-group="([a-z]+)"/g)].map((m) => m[1])).toEqual(['languages', 'tools', 'agents']);
        expect(html).toContain('Package managers · Version control · Containers');
        expect(html).toContain('Agent CLIs · Browsers');
    });

    it('every card has its logo, and no card has more than one primary action (COUNTED per card)', () => {
        const html = render(SCENE);
        for (const key of ['php', 'node', 'go', 'java', 'composer', 'git', 'docker', 'claude-code', 'codex']) {
            const c = card(html, key);
            expect(c, key).toContain(`data-tool-logo="${key}"`);
            expect((c.match(/data-card-primary=/g) ?? []).length, key).toBeLessThanOrEqual(1);
        }
    });

    it('a language card shows its versions as chips, the default starred; its primary installs the default’s patch', () => {
        const php = card(render(SCENE), 'php');
        expect(php).toMatch(/data-version-chip="php:8\.4\.11"[^>]*data-default="true"/);
        expect(php).toMatch(/data-version-chip="php:8\.3\.26"[^>]*data-default="false"/);
        expect(php).toMatch(/data-card-primary="patch"[^>]*data-version="8\.4\.27"/);
        expect(php).toContain('Install 8.4.27');
        // a language Genie installs side by side is never replaced by one "Update to 8.5.2" button
        expect(php).not.toMatch(/8\.5\.2/);
    });

    it('a missing language offers its newest install, saying nothing about passwords; a missing tool that asks shows a lock (Tynn #1062)', () => {
        const html = render(SCENE);
        const java = card(html, 'java');
        expect(java).toMatch(/data-card-primary="install"[^>]*data-version="25\.0\.1\+8"/);
        expect(java).toContain('Install 25 LTS');
        expect(java).not.toContain('no password');
        const docker = card(html, 'docker');
        expect(docker).toContain('data-card-state="missing"');
        expect(docker).toMatch(/data-install-note="docker"[^>]*title="Asks for your password"/);
        expect(docker).not.toContain('asks once');
        expect(installNote({ label: 'x', elevated: true })).toBe('asks once');
        expect(installNote({ label: 'x', elevated: false })).toBeNull();
        expect(installNote({ refused: 'no' })).toBeNull();
    });

    it('the logo is the brand mark, named for a screen reader; a tool with none shows its initial', () => {
        expect(renderToStaticMarkup(<ToolLogo tool="docker" />)).toMatch(/role="img" aria-label="Docker"[^]*<path d="M/);
        expect(renderToStaticMarkup(<ToolLogo tool="playwright" />)).toMatch(/aria-label="Playwright"[^]*>P</);
    });
});

describe('#962 — progress on the card, the rest of the page still usable', () => {
    it('an update in flight is drawn on ITS card: the step and the elapsed time, with a bar; no other card shows it', () => {
        const html = render({ ...SCENE, updating: { tool: 'git', version: '2.53.0', step: 'Downloading' } });
        const git = card(html, 'git');
        expect(git).toContain('data-card-progress="git"');
        expect(git).toContain('Downloading');
        expect(git).toContain('role="progressbar"');
        expect((html.match(/data-card-progress=/g) ?? [])).toHaveLength(1);
    });

    it('while it runs every card can still be opened: the select buttons are never disabled', () => {
        const html = render({ ...SCENE, busy: 'Installing PHP 8.4.27' });
        const selects = [...html.matchAll(/<button[^>]*data-select-tool="[^"]+"[^>]*>/g)].map((m) => m[0]);
        expect(selects.length).toBe(9);
        for (const s of selects) expect(s).not.toMatch(/\sdisabled=""/);
    });

    it('which card an action is for — the shared busy line is drawn on the card that was clicked', () => {
        expect(cardOfAction({ kind: 'toolchain.installPhp', version: '8.4.27', consent: true })).toBe('php');
        expect(cardOfAction({ kind: 'toolchain.update', tool: 'rustc' })).toBe('rust');
        expect(cardOfAction({ kind: 'toolchain.installPlaywright', version: null, consent: true })).toBe('playwright');
        expect(cardOfAction({ kind: 'toolchain.checkUpdates' })).toBeNull();
        expect(formatElapsed(0)).toBe('0:00');
        expect(formatElapsed(134_000)).toBe('2:14');
        expect(formatElapsed(3_725_000)).toBe('1:02:05');
    });
});

describe('#962 — the side panel per tool', () => {
    it('opens when a tool is chosen, and only then (Tynn #1062: one that opened by itself took the cards’ room)', () => {
        expect(render(SCENE)).not.toContain('data-toolchain-panel=');
        expect(render(SCENE, 'php')).toContain('data-toolchain-panel="php"');
    });

    it('the default as a radio per version, the system copy, the sites pinned, and Install another version', () => {
        const html = render(SCENE, 'php');
        const panel = html.slice(html.indexOf('data-toolchain-panel="php"'));
        expect(panel).toMatch(/data-is-default="php:8\.4\.11"[^>]*role="radio"[^>]*aria-checked="true"|role="radio"[^>]*aria-checked="true"[^>]*data-is-default="php:8\.4\.11"/);
        expect(panel).toMatch(/data-make-default="php:8\.3\.26"[^>]*role="radio"|role="radio"[^>]*data-make-default="php:8\.3\.26"/);
        expect(panel).toMatch(/data-use-system="php"[^>]*role="radio"|role="radio"[^>]*data-use-system="php"/);
        expect(panel).toContain('8.4.14');
        expect(panel).toMatch(/title="a\.gen, b\.gen, c\.gen"[^>]*>Used by 3 sites</);
        expect(panel).toMatch(/title="tynn\.gen"[^>]*>Used by tynn\.gen</);
        expect(panel).toMatch(/<option value="8\.4\.27"[^>]*>8\.4\.27<\/option>/);
        expect(panel).toMatch(/<option value="8\.5\.2"[^>]*>8\.5\.2<\/option>/);
        expect(panel).toMatch(/data-php-install="8\.4\.27"/);
        expect(panel).not.toContain('no password');
    });

    it('a patch per installed version, on its row in the panel', () => {
        const panel = render(SCENE, 'php').split('data-toolchain-panel="php"')[1]!;
        expect(panel).toMatch(/data-patch-update="php:8\.4\.11"[^>]*data-version="8\.4\.27"/);
        expect(panel).not.toContain('data-patch-update="php:8.3.26"');
    });

    it('another tool’s panel when it is chosen; a tool Genie keeps no versions of says what it is', () => {
        expect(render(SCENE, 'node')).toContain('data-toolchain-panel="node"');
        expect(render(SCENE, 'node')).toContain('data-node-versions="2"');
        const git = render(SCENE, 'git');
        expect(git).toContain('data-toolchain-panel="git"');
        expect(git).not.toContain('data-php-versions');
    });
});

describe('#962 — the activity feed', () => {
    it('what is running, what finished, what Check and repair found — newest first', () => {
        const tc: Tc = {
            ...SCENE,
            busy: 'Installing PHP 8.4.27',
            updated: { tool: 'go', version: '1.26.6' },
            result: 'Go 1.26.6 is installed.',
            findings: [{ kind: 'path-shadow', tool: 'node', first: { path: '/m/node', version: '22.1.0' }, newer: { path: '/g/node', version: '24.11.1' }, result: { kind: 'repaired', detail: 'Genie now runs node 24.11.1.' } }],
        };
        expect(toolchainActivity(tc).map((a) => a.kind)).toEqual(['running', 'done', 'note', 'finding']);
        const html = render(tc);
        const feed = html.slice(html.indexOf('data-toolchain-activity'));
        expect(feed).toContain('data-toolchain-busy');
        expect(feed).toContain('Installing PHP 8.4.27');
        expect(feed).toContain('data-toolchain-findings="1"');
        expect(feed).toContain('Genie now runs node 24.11.1.');
    });

    it('CONTROL: nothing has happened → the feed says so, never an empty box', () => {
        expect(toolchainActivity({ tools: [], checkedAt: 1 })).toEqual([]);
        expect(render({ tools: [], checkedAt: 1 })).toMatch(/data-toolchain-activity="0"[^]*?Nothing has run yet/);
    });
});
