import type { GuardedRule } from './helpers/real-buttons-scan.js';

/**
 * The renderer's remaining non-buttons and non-links (test/real-buttons-guard.test.ts). Counts are exact and only go down.
 *
 * Started 2026-11-01 as the whole inventory (the envelope's .ai/plans/genie-2-real-buttons-audit.md): 412 raw <button>,
 * 8 raw <a>, 9 onClick on non-controls, 3 role="button". Each conversion PR lowers its surface's entries; an entry that
 * is not debt says why it stays (`special:`).
 */
export interface AllowlistEntry {
    file: string;
    rule: GuardedRule;
    count: number;
    reason: string;
}

export const REAL_BUTTONS_ALLOWLIST: readonly AllowlistEntry[] = [
    { file: 'Shell.tsx', rule: 'raw-button', count: 4, reason: 'debt: converts in the workspace shell PR' },
    { file: 'components/ChatFlyout.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'special: link delegation on the chat log. The click targets are real <a> elements rendered by the markdown renderer (file, agent and workspace links); the container only routes them in-app.' },
    { file: 'components/ChatProse.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'special: stopCopyClick only stops a click on the copy control from reaching the row (no action of its own).' },
    { file: 'components/Dashboard.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'special: the agent row is a grid row (role="row", tabIndex 0, J/K move and Enter opens), shown as clickable by cursor-pointer and hover. It holds its own Buttons (fixes, tray doors), so it cannot itself be a <button>.' },
    { file: 'components/PlanColumn.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'special: the plan column resize handle, a focusable role="separator" with aria-valuenow; double-click resets the width (Genie 1 gutter).' },
    { file: 'components/StreamRow.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'special: link delegation on the prose cell for real <a> elements rendered by the markdown renderer (file, agent and workspace links). The row itself is a react-fancy Button when it is a control.' },
    { file: 'components/TynnBoardPanel.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'special: role="menu" container only stops propagation so a click inside the menu does not close it.' },
    { file: 'components/TynnBoardPanel.tsx', rule: 'raw-button', count: 9, reason: 'debt: converts in the Tynn tab PR' },
    { file: 'components/Workspace.tsx', rule: 'raw-button', count: 31, reason: 'debt: converts in the workspace shell PR' },
    { file: 'components/AddWorkspaceWizard.tsx', rule: 'menu-as-button', count: 1, reason: 'special: the wizard\'s stepper (aria-current="step"); react-fancy has no stepper component, so it stays a Button until fancy ships one' },
    { file: 'components/DesignedTab.tsx', rule: 'menu-as-button', count: 1, reason: 'debt: a menu or tab item made into a Button; becomes react-fancy Tabs/Sidebar/Navbar in the menus branch (the owner, 2026-11-01: "it\'s a menu")' },
    { file: 'components/FeatureSurfaces.tsx', rule: 'menu-as-button', count: 1, reason: 'debt: the Browser surface\'s site chips (aria-current on a Button) navigate, so they become links in the menus follow-up PR; the Settings nav is already a react-fancy Sidebar' },
    { file: 'components/GenieBrowserChrome.tsx', rule: 'menu-as-button', count: 2, reason: 'debt: a menu or tab item made into a Button; becomes react-fancy Tabs/Sidebar/Navbar in the menus branch (the owner, 2026-11-01: "it\'s a menu")' },
    { file: 'components/TynnBoardPanel.tsx', rule: 'menu-as-button', count: 3, reason: 'debt: a menu or tab item made into a Button; held for the open Tynn-tab PRs, then react-fancy Tabs' },
    { file: 'components/Workspace.tsx', rule: 'menu-as-button', count: 1, reason: 'debt: a menu or tab item made into a Button; held for the open Tynn-tab PRs, then react-fancy Tabs' },
];
