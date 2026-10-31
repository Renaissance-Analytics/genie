import { registerIcons } from '@particle-academy/react-fancy';
import * as lucide from '@particle-academy/react-fancy/icons';
import { FEATURE_ICONS } from '../core/rail-view.js';
import { NAV_GROUPS } from '../core/settings-nav.js';
import { KIND_COPY } from './components/AddWorkspaceWizard.js';

/**
 * ICON REGISTRATION — and the reason it has its own file and its own test.
 *
 * Fancy's `Icon` resolves a kebab-case name out of a registry. **An unregistered name renders
 * an empty span.** No warning, no fallback glyph, no error: the markup is structurally correct
 * and every test of every surface passes, and the app shows a row of blank gaps where the
 * icons should be.
 *
 * That was not hypothetical. It showed up in a render dump while building the shell — four
 * feature buttons with correct labels, correct classes and `<span>` contents of nothing. On a
 * green suite.
 *
 * So: registration happens here, once, and `test/icons.test.ts` asserts that **every name any
 * surface asks for actually resolves.** Which is the only version of this check worth having
 * — "we called registerIcons" proves nothing about the name a component passes.
 *
 * `@particle-academy/react-fancy/icons` re-exports Lucide from inside the kit, so this adds
 * nothing to the dependency tree.
 */

/**
 * Every icon name the application uses, in one list.
 *
 * Adding an `<Icon name="…">` anywhere means adding the name here, and the test fails
 * otherwise — which is the point. A list that only has to agree with itself is a list that
 * drifts from the components silently.
 */
export const ICON_NAMES: readonly string[] = [
    // chrome
    'search', 'inbox', 'layout-list', 'sparkles',
    // The Tynn tab's board (genie#1295): each card's next step, delete, its claimant.
    'rocket', 'shield-check', 'circle-check', 'ban', 'trash-2', 'user',
    // Its detail flyout: list marks (tasks, features, produces) and a story's facts (outcome, risk).
    'square-check', 'tag', 'package', 'target', 'triangle-alert',
    // The Tynn tab's pages (row W1 on): tynn.ai's nav icons, and WIP's lens chips, story heading and steps.
    'columns-3', 'circle-play', 'book-open',
    // Its claims (row B3): Claim + Start and Assign to.
    'hand', 'user-plus',
    'settings', 'folder', 'x', 'square-terminal', 'pin',
    // The rail's Hosting / AgentInbox rows (Toolchain uses 'wrench'), and a hibernated workspace's row.
    'server', 'mail', 'moon',
    // The workspace row's background-process indicator (Genie 1's runtime pill, 2026-10-19).
    'cpu',
    // Connect to another machine (the title bar's button, Genie 1's Hosts), and a Tynn workstation's desktop / cloud.
    'monitor', 'cloud',
    // A Tynn workstation's role (genie#1278 W6): pilot, drone.
    'navigation', 'bot',
    // A workspace's GitHub (IssueWatch) panel heading (Tynn #806), its rows' kinds and its Refresh.
    'git-pull-request', 'circle-dot', 'shield-alert', 'refresh-cw',
    // The workspace header's Files button (the board): `folder-tree` · Files · ⌘B.
    'folder-tree',
    // The Add workspace modal's header (Genie 1's): `folder-plus` · Add workspace.
    'folder-plus',
    // The workspace's popped-out-files bar (the board).
    'external-link',
    // the workspace header's repo chips
    'git-branch', 'circle-alert',
    // the Agent view header's Stop
    'square',
    // the four feature icons
    ...FEATURE_ICONS.map((f) => f.icon),
    // the Settings sidebar (Genie 1's, core/settings-nav.ts) — named in data, so registered from it
    ...NAV_GROUPS.flatMap((g) => g.items.map((i) => i.icon)),
    // dashboard rows
    'users', 'plus',
    // delivery kinds
    'git-commit-horizontal', 'file-code', 'arrow-right-left', 'message-square-reply',
    // The file panel's conflict banner (the board's `git-merge`).
    'git-merge',
    // A file sent with your message (the chat's attachment chips).
    'paperclip',
    // Where an agent's run began in its recorded history, and the rows left out of it.
    'history',
    // The Dashboard's "From Tynn" door (§6.1).
    'link',

    /*
     * The stream ledger's icons.
     *
     * These reach `Icon` as `name={row.icon}` rather than as a literal, so the source scan in
     * `test/icons.test.ts` cannot see them — and an unregistered name renders an EMPTY SPAN
     * with no warning. The test therefore drives the real `ledgerRow` over every event kind
     * and every tool kind and asserts each icon it emits resolves, which is a guard that does
     * not depend on how the JSX happens to be written.
     */
    'message-square', 'brain', 'wrench', 'pencil', 'gauge', 'list-checks', 'scissors',
    'rotate-ccw', 'ellipsis',
    'eye-off', 'pause', 'play',
    // The header's update chip: download, then restart to install.
    'download', 'rotate-cw',
    // The timeline strip's `Lanes ▾` toggle (the board), open or closed.
    'chevron-down', 'chevron-up',
    // The turns layout's collapsed card.
    'chevron-right',
    // The Turns column's collapse (to just the numbers) and expand controls.
    'chevron-left',
    // The right column's strip below 1100 px: the door to the column.
    'panel-right',
    // The Active Plan column's toggle at the workspace tab row's right end (beta.33 item 11).
    'panel-right-close', 'panel-right-open',
    'panel-left',
    'panel-left-open',
    'eye',
    'monitor-cog',
    // ^ the rail's tools and its collapsed state (Tynn #799/#282)
    'info', 'circle-help', 'file-text', 'globe', 'check',
    // The chat's markup (genie#1263): a copy button, the <result> card, the <highlight> callout, the <followup> question.
    // react-fancy's ContentRenderer copy buttons (5.67.0) ask for 'copy', then 'check' or 'x' — all three registered here.
    'copy', 'clipboard-list', 'lightbulb', 'message-circle-question',
    // The Genie Browser's address bar on a .gen site (its own https origin, Genie's certificate); the file panel's lock badge.
    'lock',
    // The Genie browser window: a tab whose page is loading.
    'loader',
    // The Tynn tab's live board (genie#1295 B4): following Tynn, or reconnecting to it.
    'radio', 'wifi-off',
    // The file panel's word-wrap toggle (beta.33 item 15; Genie 1's IconWrap).
    'wrap-text',
    // The Open existing / Import from Git wizard (Add workspace parity item 7): its header and its Next.
    'layers', 'arrow-right',
    // The optional Tynn project's "Create new project" (Add workspace parity item 5): back to Select existing.
    'arrow-left',
    // The phone (genie#1346): a workspace's Files, the composer's camera and gallery, a folder's Up and Upload.
    'folder-open', 'camera', 'image', 'corner-left-up', 'upload', 'file',
    // Apps and scripts that report to agents (genie#1345): a site (globe), a process (cog), a script key; a message's level
    // (circle-check / circle-x / info); a card action in flight. Named in data (`APP_KIND_ICON`), so registered here.
    'cog', 'key-round', 'circle-x', 'loader-circle',
    // ...and what the folder is (Genie 1's KIND_COPY) — named in data (`name={kind.icon}`), so registered from it.
    ...Object.values(KIND_COPY).map((k) => k.icon),
];

/** Lucide exports components in PascalCase; `registerIcons` kebab-cases the keys itself. */
function pascal(kebab: string): string {
    return kebab.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/**
 * Register exactly what the app asks for, and nothing else.
 *
 * Not the whole of Lucide: the registry would carry well over a thousand components into the
 * renderer bundle to resolve a dozen names.
 */
export function registerAppIcons(): void {
    const icons: Record<string, lucide.LucideIcon> = {};

    for (const name of ICON_NAMES) {
        const component = (lucide as unknown as Record<string, lucide.LucideIcon | undefined>)[pascal(name)];
        // A missing export is NOT skipped quietly. Silence here is the exact failure this file
        // exists to prevent — it would hand the registry a short list and let the UI render
        // gaps. The test names the offender; this makes sure a build cannot hide it either.
        if (!component) throw new Error(`icon "${name}" (${pascal(name)}) is not exported by the kit's Lucide re-export`);
        icons[pascal(name)] = component;
    }

    registerIcons(icons as Parameters<typeof registerIcons>[0]);
}
