/**
 * THE TOOLCHAIN VIEW'S MODEL (Tynn #962): what the approved redesign draws, worked out from the toolchain section main
 * already sends — no new port. The owner approved ArtBoard item 958-toolchain-redesign on 2026-11-20 (mockup:
 * .ai/sandbox/958-toolchain-mockup.html):
 *
 * - a PROBLEMS STRIP: each thing that needs the person, with the one action that fixes it ({@link toolchainProblems});
 * - LOGO CARDS grouped by type, each with ONE primary action ({@link toolchainCards});
 * - PROGRESS ON THE CARD it is for ({@link cardOfAction}): main reports every install through one shared busy line, so
 *   the card is the one the person clicked;
 * - a SIDE PANEL per tool ({@link defaultSelection} picks the first);
 * - an ACTIVITY FEED ({@link toolchainActivity});
 * - no raw shell command: an install that asks for a password shows a lock ({@link installNote}); Genie's own say nothing.
 *
 * Pure: nothing here renders or runs. FeatureSurfaces' ToolchainSurface draws it.
 */

import type { ToolStatus } from '../core/toolchain.js';
import { PREREQUISITES } from '../core/toolchain.js';
import { DOCKER_DAEMON_WORDS } from '../core/docker-engine.js';
import { patchWithinLine } from '../core/toolchain-update.js';
import type { FeatureAction, InstallPreview, ToolchainSection } from './features.js';

/** A language Genie keeps versions of: its versions view, its default, and its install/remove actions. */
export type LangKey = 'php' | 'node' | 'python' | 'go' | 'rust' | 'ruby' | 'java' | 'dotnet';
/** The languages installed SIDE BY SIDE (Tynn #713): with a view, the scan's single-version row is not also a card's action. */
export const SIDE_BY_SIDE_LANGS: readonly LangKey[] = ['php', 'node', 'python', 'java'];
const LANGS: readonly LangKey[] = ['php', 'node', 'python', 'go', 'rust', 'ruby', 'java', 'dotnet'];

export type CardGroupId = 'languages' | 'tools' | 'agents' | 'other';
/** The approved groups, in order. A tool the table does not know goes under Other, never dropped. */
export const CARD_GROUPS: readonly { readonly group: Exclude<CardGroupId, 'other'>; readonly label: string; readonly keys: readonly string[] }[] = [
    { group: 'languages', label: 'Languages', keys: ['php', 'node', 'python', 'go', 'rust', 'ruby', 'java', 'dotnet'] },
    { group: 'tools', label: 'Package managers · Version control · Containers', keys: ['composer', 'npm', 'cargo', 'git', 'docker'] },
    { group: 'agents', label: 'Agent CLIs · Browsers', keys: ['claude-code', 'codex', 'playwright'] },
];

const TITLES: Readonly<Record<string, string>> = {
    php: 'PHP', node: 'Node', python: 'Python', go: 'Go', rust: 'Rust', ruby: 'Ruby', java: 'Java', dotnet: '.NET',
    composer: 'Composer', npm: 'npm', cargo: 'Cargo', git: 'Git', docker: 'Docker', 'claude-code': 'Claude Code', codex: 'Codex', playwright: 'Playwright',
};
export const toolTitle = (key: string): string => TITLES[key] ?? key;

/** The scan's tool name → its card (the Rust card is `rustc`'s row). */
export const cardKeyOfTool = (tool: string): string => (tool === 'rustc' ? 'rust' : tool);

/**
 * - `ok`: installed, current; `quiet`: installed, newest not known (never the word "unknown", TC1);
 * - `update`: a newer version is offered; `problem`: it needs the person (the strip says why); `missing`: not here.
 */
export type CardState = 'ok' | 'quiet' | 'update' | 'problem' | 'missing';

export interface ToolCard {
    readonly key: string;
    readonly title: string;
    readonly group: CardGroupId;
    /** Its scan row, when it is drawn as one (go, git, the agent CLIs…); `null` for a side-by-side language with a view. */
    readonly tool: ToolStatus | null;
    /** The language whose versions its panel shows; `null` for a tool Genie keeps one copy of. */
    readonly lang: LangKey | null;
    /** The version under its name: the default, else the one installed. */
    readonly version: string | null;
    /**
     * What the card is using, said in words (Tynn #1062): `default` — Genie's copy, the default; `system` — the copy that
     * came with the machine (on its PATH); `null` — a tool Genie keeps one copy of, or nothing chosen.
     */
    readonly inUse: 'default' | 'system' | null;
    /** Its installed versions (the default marked); one `system` chip when only the PATH copy is here. */
    readonly chips: readonly { readonly version: string; readonly isDefault: boolean; readonly system?: boolean }[];
    readonly state: CardState;
    /** A side-by-side language card's primary: the default's patch (installed beside it), or its first install. */
    readonly primary?: { readonly kind: 'patch'; readonly from: string; readonly version: string } | { readonly kind: 'install'; readonly version: string; readonly label: string } | undefined;
    /** Why a language cannot be installed here (macOS/Linux for some), said on its card instead of a button. */
    readonly refused?: string | undefined;
    /**
     * A side-by-side language Genie manages NO version of: its scan row's name, because the card is then the system
     * copy's (or none): its system-package install (pacman, Tynn #968), its refusal, its `data-tool`.
     */
    readonly systemTool?: string | undefined;
}

type View = { readonly managed: ReadonlyArray<{ readonly version: string; readonly advisory?: string; readonly usedBy?: readonly string[] }>; readonly system: { readonly version: string; readonly advisory?: string } | null; readonly available: ReadonlyArray<{ readonly version: string; readonly installed: boolean; readonly line?: number }>; readonly installRefused?: string };

export function langView(tc: ToolchainSection, lang: LangKey): View | undefined {
    return tc[lang] as View | undefined;
}

/** A side-by-side language's patch for one installed version: the newest build on its own line, never another line. */
export function patchFor(lang: LangKey, version: string, view: View): string | null {
    return (SIDE_BY_SIDE_LANGS as readonly string[]).includes(lang) ? patchWithinLine(lang as 'php' | 'node' | 'python' | 'java', version, view.available) : null;
}

const stateOfTool = (t: ToolStatus): CardState =>
    t.tone === 'broken' || t.tone === 'security-update' || t.signedOut === true || t.daemon !== undefined ? 'problem'
    : t.tone === 'not-installed' ? 'missing'
    : t.tone === 'update-available' ? 'update'
    : t.tone === 'up-to-date' ? 'ok'
    : 'quiet';

/** Java's lines are named by number ("25 LTS"); every other language by its version. */
const installLabel = (lang: LangKey, a: { readonly version: string; readonly line?: number }): string => (lang === 'java' && a.line !== undefined ? `Install ${a.line} LTS` : `Install ${a.version}`);

function langCard(tc: ToolchainSection, lang: LangKey, view: View, tool: ToolStatus | null, row: ToolStatus | null = tool): Omit<ToolCard, 'group'> {
    const current = tc.defaults?.[lang] ?? null;
    const chips = view.managed.length > 0
        ? view.managed.map((m) => ({ version: m.version, isDefault: m.version === current }))
        : view.system ? [{ version: view.system.version, isDefault: current === null, system: true }] : [];
    const sideBySide = tool === null;
    const advisory = view.managed.some((m) => m.advisory) || view.system?.advisory !== undefined;
    // The patch the card offers: the default's, else the first installed version's that has one.
    const order = [...view.managed].sort((a, b) => (a.version === current ? -1 : b.version === current ? 1 : 0));
    const patched = sideBySide ? order.map((m) => ({ from: m.version, version: patchFor(lang, m.version, view) })).find((p) => p.version !== null) : undefined;
    const addable = view.available.filter((a) => !a.installed);
    // Java: the newest LTS line; the others: what main lists first (its newest).
    const first = lang === 'java' ? [...addable].sort((a, b) => (b.line ?? 0) - (a.line ?? 0))[0] : addable[0];
    const missing = view.managed.length === 0 && view.system === null && (tool === null || tool.installed === null);
    const primary = !sideBySide ? undefined
        : patched?.version ? { kind: 'patch' as const, from: patched.from, version: patched.version }
        : view.managed.length === 0 && !view.installRefused && first ? { kind: 'install' as const, version: first.version, label: installLabel(lang, first) }
        : undefined;
    const state: CardState = tool !== null && stateOfTool(tool) === 'problem' ? 'problem'
        : advisory ? 'problem'
        : missing ? 'missing'
        : patched?.version || (tool !== null && tool.tone === 'update-available') ? 'update'
        : tool !== null ? stateOfTool(tool)
        : 'ok';
    return {
        key: lang,
        title: toolTitle(lang),
        tool,
        lang,
        version: current ?? view.managed[0]?.version ?? view.system?.version ?? tool?.installed ?? null,
        inUse: current !== null && view.managed.some((m) => m.version === current) ? 'default' : current === null && view.system !== null ? 'system' : null,
        chips,
        state,
        ...(primary ? { primary } : {}),
        ...(sideBySide && view.managed.length === 0 && view.installRefused ? { refused: view.installRefused } : {}),
        ...(sideBySide && view.managed.length === 0 && row !== null ? { systemTool: row.tool } : {}),
    };
}

/** Every card, in its group, in the approved order; empty groups dropped. */
export function toolchainCards(tc: ToolchainSection): Array<{ group: CardGroupId; label: string; cards: ToolCard[] }> {
    const cards: Array<Omit<ToolCard, 'group'>> = [];
    const seen = new Set<string>();
    const rows = new Map(tc.tools.map((t) => [cardKeyOfTool(t.tool), t] as const));
    for (const t of tc.tools) {
        const key = cardKeyOfTool(t.tool);
        if (seen.has(key)) continue;
        seen.add(key);
        const lang = (LANGS as readonly string[]).includes(key) ? (key as LangKey) : null;
        const view = lang ? langView(tc, lang) : undefined;
        if (lang && view) {
            cards.push(langCard(tc, lang, view, (SIDE_BY_SIDE_LANGS as readonly string[]).includes(lang) ? null : t, t));
        } else {
            cards.push({ key, title: toolTitle(key), tool: t, lang: null, version: t.installed, inUse: null, chips: [], state: stateOfTool(t) });
        }
    }
    // A language Genie keeps versions of that the scan has no row for (Java, .NET, Ruby): its card comes from its view.
    for (const lang of LANGS) {
        const view = langView(tc, lang);
        if (!view || seen.has(lang) || rows.has(lang)) continue;
        seen.add(lang);
        cards.push(langCard(tc, lang, view, null));
    }
    if (tc.playwright && !seen.has('playwright')) {
        const pw = tc.playwright;
        const ready = pw.sets.filter((s) => s.ready);
        cards.push({
            key: 'playwright', title: 'Playwright', tool: null, lang: null, inUse: null,
            version: ready.find((s) => s.version === pw.stable)?.version ?? ready[0]?.version ?? null,
            chips: pw.sets.map((s) => ({ version: s.version, isDefault: s.version === pw.stable })),
            state: pw.sets.length === 0 ? 'missing' : pw.sets.some((s) => !s.ready) ? 'update' : 'ok',
        });
    }
    const groupOf = (key: string): CardGroupId => CARD_GROUPS.find((g) => g.keys.includes(key))?.group ?? 'other';
    const rank = (key: string): number => CARD_GROUPS.find((g) => g.keys.includes(key))?.keys.indexOf(key) ?? 0;
    const out = [...CARD_GROUPS.map((g) => ({ group: g.group as CardGroupId, label: g.label })), { group: 'other' as CardGroupId, label: 'Other' }].map((g) => ({
        ...g,
        cards: cards.filter((c) => groupOf(c.key) === g.group).sort((a, b) => rank(a.key) - rank(b.key)).map((c) => ({ ...c, group: g.group })),
    }));
    return out.filter((g) => g.cards.length > 0);
}

/**
 * Whether an install asks for the password (the system package manager does, once). Genie's own copies never do, and
 * say nothing about it (Tynn #1062: "no password" beside every button was noise; the prompt explains itself).
 */
export function installNote(preview: InstallPreview | undefined): 'asks once' | null {
    if (!preview || !('label' in preview)) return null;
    return preview.elevated ? 'asks once' : null;
}

/**
 * A REFUSAL, IN PLAIN WORDS (Tynn #1062: the engine's sentence in a red banner read as an error dumped on the person). A
 * short line; the version to install instead when the refusal names one; the full sentence as `details`, behind a
 * "Details" disclosure. A reason short enough to read is said as it is.
 */
export function plainRefusal(reason: string): { text: string; install?: string; details?: string; vcRuntime?: true } {
    // Tynn #1066: a build that needs a newer Visual C++ runtime (8.6, vs18) — one line, and its own button.
    const runtime = /^(PHP [\d.]+) needs a newer Microsoft Visual C\+\+ runtime/.exec(reason);
    if (runtime) return { text: `${runtime[1]} needs a newer Microsoft Visual C++ runtime.`, vcRuntime: true, details: reason };
    const stale = /current (\w[\w.]*) [\d.]+ build is ([\d.]+), not ([\d.]+)/i.exec(reason);
    if (stale) return { text: `${stale[1]} ${stale[3]} isn't available any more.`, install: stale[2]!, details: reason };
    const missing = /^(\w[\w.]*) ([\d.]+) is not a version Genie manages here/i.exec(reason);
    if (missing) return { text: `${missing[1]} ${missing[2]} isn't installed.`, details: reason };
    if (reason.length <= 90) return { text: reason };
    const first = reason.split(/;\s/)[0]!.replace(/[.\s]+$/, '');
    return { text: `${first}.`, details: reason };
}

export interface ToolchainProblem {
    /** Stable: the tool, or `<lang>:<version>` for one installed version. */
    readonly key: string;
    /** The card it is about: the panel a click on its title opens. */
    readonly card: string;
    readonly title: string;
    readonly why: string | null;
    /** The one button's words. */
    readonly label: string;
    /** What the button sends; `null` = open the tool's panel (nothing one click can fix). */
    readonly action: FeatureAction | null;
    /** Said beside the button: whether it asks for a password. */
    readonly note?: 'asks once' | 'no password' | undefined;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * WHAT NEEDS THE PERSON, each with its one fix, most urgent first: a security fix (a tool's, or an installed version's),
 * a tool that cannot run, what Check and repair found missing, Docker absent (every hosted database, Redis and mail
 * runs on it), and last an agent CLI that only needs a login. `servicesWaiting`: services that cannot start until Docker is here.
 */
export function toolchainProblems(tc: ToolchainSection, servicesWaiting = 0): ToolchainProblem[] {
    const out: ToolchainProblem[] = [];
    const cards = new Map(toolchainCards(tc).flatMap((g) => g.cards).map((c) => [c.key, c] as const));
    // Security first.
    for (const c of cards.values()) {
        if (c.tool && c.tool.tone === 'security-update') {
            const to = c.tool.patch ?? c.tool.latest ?? undefined;
            out.push({
                key: c.key, card: c.key, title: `${c.title}${c.tool.installed ? ` ${c.tool.installed}` : ''} has a security fix`, why: c.tool.advisory ?? null,
                label: to ? `Update to ${to}` : 'Update', action: { kind: 'toolchain.update', tool: c.tool.tool, ...(to ? { version: to } : {}) },
            });
        }
        const view = c.lang ? langView(tc, c.lang) : undefined;
        if (!c.lang || !view) continue;
        for (const m of view.managed) {
            if (!m.advisory) continue;
            const patch = patchFor(c.lang, m.version, view);
            const sites = m.usedBy?.length ?? 0;
            const why = [m.advisory.replace(/\.?$/, '.'), sites > 0 ? `${plural(sites, 'site runs', 'sites run')} on it.` : null, patch ? `${patch} installs beside it, on the same line.` : null].filter(Boolean).join(' ');
            out.push({
                key: `${c.lang}:${m.version}`, card: c.key, title: `${c.title} ${m.version} has a security fix`, why,
                label: patch ? `Install ${patch}` : 'Versions',
                action: patch ? ({ kind: INSTALL_KIND[c.lang], version: patch, consent: true } as FeatureAction) : null,
            });
        }
        if (view.system?.advisory) {
            out.push({ key: `${c.lang}:system`, card: c.key, title: `The ${c.title} on your PATH has a security fix`, why: view.system.advisory, label: 'Versions', action: null });
        }
    }
    for (const c of cards.values()) {
        if (!c.tool) continue;
        if (c.tool.tone === 'broken') out.push({ key: c.key, card: c.key, title: `${c.title} can't run`, why: c.tool.problem ?? null, label: 'Repair', action: { kind: 'toolchain.repairCli', tool: c.tool.tool } });
    }
    for (const f of tc.findings ?? []) {
        if (f.result.kind !== 'needs-install') continue;
        const tool = f.result.tool;
        const label = PREREQUISITES.find((p) => p.name === tool)?.label ?? toolTitle(tool);
        out.push({ key: tool, card: cardKeyOfTool(tool), title: `${label} isn't installed`, why: f.result.reason, label: 'Install', action: { kind: 'toolchain.install', tool, consent: true } });
    }
    const docker = cards.get('docker');
    const plan = tc.installs?.['docker'];
    if (docker?.tool?.tone === 'not-installed' && plan && 'label' in plan) {
        const why = `Databases, Redis and mail for your sites run on it.${servicesWaiting > 0 ? ` ${plural(servicesWaiting, 'service is', 'services are')} waiting.` : ''}`;
        out.push({ key: 'docker', card: 'docker', title: "Docker isn't installed", why, label: 'Install Docker', note: installNote(plan) ?? undefined, action: { kind: 'toolchain.install', tool: 'docker', consent: true } });
    }
    // Tynn #970: Docker installed and not usable: off (Start), or a group this login does not have yet (a new login).
    const daemon = docker?.tool?.installed !== null ? docker?.tool?.daemon : undefined;
    if (daemon === 'not-running' || daemon === 'no-access') {
        out.push({ key: 'docker', card: 'docker', title: daemon === 'not-running' ? "Docker isn't running" : 'Docker needs your account in its group', why: `${DOCKER_DAEMON_WORDS[daemon].why}${servicesWaiting > 0 ? ` ${plural(servicesWaiting, 'service is', 'services are')} waiting.` : ''}`, label: 'Start Docker', note: 'asks once', action: { kind: 'toolchain.startDocker' } });
    } else if (daemon === 'needs-login') {
        out.push({ key: 'docker', card: 'docker', title: 'Docker needs a new login', why: DOCKER_DAEMON_WORDS['needs-login'].why, label: 'Docker', action: null });
    }
    // Last: a signed-out agent CLI runs; it only waits for a login.
    for (const c of cards.values()) {
        if (c.tool?.signedOut && c.tool.tone !== 'broken') out.push({ key: c.key, card: c.key, title: `${c.title} is signed out`, why: 'Its agents start once you log in.', label: 'Log in', action: { kind: 'toolchain.login', tool: c.tool.tool } });
    }
    return out;
}

export const INSTALL_KIND: Readonly<Record<LangKey, 'toolchain.installPhp' | 'toolchain.installNode' | 'toolchain.installPython' | 'toolchain.installGo' | 'toolchain.installRust' | 'toolchain.installRuby' | 'toolchain.installJava' | 'toolchain.installDotnet'>> = {
    php: 'toolchain.installPhp', node: 'toolchain.installNode', python: 'toolchain.installPython', go: 'toolchain.installGo',
    rust: 'toolchain.installRust', ruby: 'toolchain.installRuby', java: 'toolchain.installJava', dotnet: 'toolchain.installDotnet',
};
export const REMOVE_KIND: Readonly<Record<LangKey, 'toolchain.removePhp' | 'toolchain.removeNode' | 'toolchain.removePython' | 'toolchain.removeGo' | 'toolchain.removeRust' | 'toolchain.removeRuby' | 'toolchain.removeJava' | 'toolchain.removeDotnet'>> = {
    php: 'toolchain.removePhp', node: 'toolchain.removeNode', python: 'toolchain.removePython', go: 'toolchain.removeGo',
    rust: 'toolchain.removeRust', ruby: 'toolchain.removeRuby', java: 'toolchain.removeJava', dotnet: 'toolchain.removeDotnet',
};

/** The three tiles: installed and fine; with an update (and how many of those are security fixes); needing the person. */
export function toolchainTally(groups: ReadonlyArray<{ readonly cards: readonly ToolCard[] }>, problems: readonly ToolchainProblem[]): { ready: number; updates: number; security: number; needYou: number } {
    const cards = groups.flatMap((g) => g.cards);
    return {
        ready: cards.filter((c) => c.state === 'ok' || c.state === 'quiet').length,
        updates: cards.filter((c) => c.state === 'update').length,
        security: problems.filter((p) => / has a security fix$/.test(p.title)).length,
        needYou: problems.length,
    };
}

/** The card an action is for: where its progress is drawn while main's one busy line runs. `null`: no one card's. */
export function cardOfAction(action: FeatureAction): string | null {
    switch (action.kind) {
        case 'toolchain.update':
        case 'toolchain.install':
        case 'toolchain.repairCli':
        case 'toolchain.login':
            return cardKeyOfTool(action.tool);
        case 'toolchain.installPlaywright':
            return 'playwright';
        case 'toolchain.startDocker':
            return 'docker';
        case 'toolchain.setDefault':
            return action.lang;
        default: {
            const m = /^toolchain\.(install|remove)(Php|Node|Python|Go|Rust|Ruby|Java|Dotnet)$/.exec(action.kind);
            return m ? m[2]!.toLowerCase() : null;
        }
    }
}

/** 134 000 ms → "2:14"; an hour and more → "1:02:05". */
/** The card main's ONE busy line is drawn on: the one the person clicked. `started` = its work has been seen busy. */
export interface InFlight {
    readonly card: string;
    readonly at: number;
    readonly started: boolean;
}

/** How long a click whose work never showed busy (a refusal, nothing to run) keeps its card marked. */
const NEVER_STARTED_MS = 60_000;

/**
 * THE IN-FLIGHT MARK, after a snapshot (Tynn #968; toolchain row 1125-195556-df6ca9). It ends only once the work it marks
 * has ended: busy (or an update, or a pending click) seen, then gone. A snapshot with nothing busy that arrives BEFORE the
 * work starts (the previous install's rescan) keeps it: clearing on that left composer's busy line with no card.
 */
export function nextInFlight(current: InFlight | null, tc: { readonly busy?: string | undefined; readonly updating?: unknown }, now: number, pending: boolean): InFlight | null {
    if (current === null) return null;
    const active = tc.busy !== undefined || tc.updating !== undefined || pending;
    if (active) return current.started ? current : { ...current, started: true };
    if (current.started) return null;
    return now - current.at > NEVER_STARTED_MS ? null : current;
}

export function formatElapsed(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const pad = (n: number) => String(n).padStart(2, '0');
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/**
 * "FIX N PROBLEMS": the strip's actions sent one at a time. The next goes only when nothing is running; a warning (an
 * update that needs the person's go-ahead) or a NEW refusal (more than `refusalsBefore`, the count when the run began)
 * ends the run, so the person reads it before anything else goes.
 */
export function nextFix(queue: readonly FeatureAction[], tc: ToolchainSection | null, refusalsBefore = 0): { send: FeatureAction | null; rest: FeatureAction[] } {
    if (queue.length === 0) return { send: null, rest: [] };
    if (tc?.warning || (tc?.refusals?.length ?? 0) > refusalsBefore) return { send: null, rest: [] };
    if (tc?.busy || tc?.updating) return { send: null, rest: [...queue] };
    return { send: queue[0]!, rest: queue.slice(1) };
}

export type ActivityItem =
    | { readonly kind: 'running'; readonly text: string; readonly source: 'busy' | 'updating' | 'check' }
    | { readonly kind: 'done'; readonly text: string }
    | { readonly kind: 'note'; readonly text: string }
    | { readonly kind: 'finding'; readonly index: number };

/** What is running now, what just finished, the last outcome, and what Check and repair found — in that order. */
export function toolchainActivity(tc: ToolchainSection): ActivityItem[] {
    const out: ActivityItem[] = [];
    if (tc.busy) out.push({ kind: 'running', text: tc.busy, source: 'busy' });
    if (tc.updating) out.push({ kind: 'running', text: `${toolTitle(cardKeyOfTool(tc.updating.tool))}${tc.updating.version ? ` → ${tc.updating.version}` : ''}: ${tc.updating.step}`, source: 'updating' });
    if (tc.checkRun?.running) out.push({ kind: 'running', text: 'Checking for updates', source: 'check' });
    if (tc.updated) out.push({ kind: 'done', text: `${toolTitle(cardKeyOfTool(tc.updated.tool))} is now ${tc.updated.version}` });
    if (tc.result) out.push({ kind: 'note', text: tc.result });
    (tc.findings ?? []).forEach((_, index) => out.push({ kind: 'finding', index }));
    return out;
}

/**
 * WHAT A SITE WITH NO PHP VERSION CHOSEN RUNS (Tynn #1066): Genie's default when there is one (its `current/php` is first
 * on the PATH sites get), else the system's, else nothing. A fresh Windows VM read "cannot start … there is no system
 * PHP" under four installed PHPs.
 */
export function unpinnedSitesLine(current: string | null, system: string | null): string {
    if (current !== null) return `Sites with no version chosen run PHP ${current}, the default.`;
    if (system !== null) return `Sites with no version chosen run PHP ${system}, the system's.`;
    return 'Sites with no version chosen cannot start until PHP is installed: there is no system PHP.';
}
