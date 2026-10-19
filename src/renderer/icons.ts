import { registerIcons } from '@particle-academy/react-fancy';
import * as lucide from '@particle-academy/react-fancy/icons';
import { FEATURE_ICONS } from '../core/rail-view.js';

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
    'settings', 'folder', 'x', 'square-terminal', 'pin',
    // The rail's Hosting / AgentInbox rows (Toolchain uses 'wrench'), and a hibernated workspace's row.
    'server', 'mail', 'moon',
    // The workspace row's background-process indicator (Genie 1's runtime pill, 2026-10-19).
    'cpu',
    // A workspace's GitHub (IssueWatch) panel heading (Tynn #806).
    'git-pull-request',
    // The workspace header's Files button (the board): `folder-tree` · Files · ⌘B.
    'folder-tree',
    // The workspace's popped-out-files bar (the board).
    'external-link',
    // the workspace header's repo chips
    'git-branch', 'circle-alert',
    // the Agent view header's Stop
    'square',
    // the four feature icons
    ...FEATURE_ICONS.map((f) => f.icon),
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
    'panel-left',
    'panel-left-open',
    'eye',
    'monitor-cog',
    // ^ the rail's tools and its collapsed state (Tynn #799/#282)
    'info', 'circle-help', 'file-text', 'globe', 'check',
    // The Genie Browser's address bar on a .gen site (its own https origin, Genie's certificate).
    'lock',
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
