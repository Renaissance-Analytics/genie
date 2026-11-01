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
    { file: 'DoctorApp.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the other windows PR' },
    { file: 'Shell.tsx', rule: 'raw-button', count: 4, reason: 'debt: converts in the workspace shell PR' },
    { file: 'components/AddForms.tsx', rule: 'raw-button', count: 7, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/AddWorkspaceModal.tsx', rule: 'raw-button', count: 4, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/AddWorkspacePreview.tsx', rule: 'raw-button', count: 11, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/AddWorkspaceWizard.tsx', rule: 'raw-button', count: 11, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/AgiRemoteChoice.tsx', rule: 'raw-button', count: 9, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/ChatFlyout.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'special: link delegation on the chat log. The click targets are real <a> elements rendered by the markdown renderer (file, agent and workspace links); the container only routes them in-app.' },
    { file: 'components/ChatProse.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'special: stopCopyClick only stops a click on the copy control from reaching the row (no action of its own).' },
    { file: 'components/ConnectMenu.tsx', rule: 'raw-button', count: 10, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/Dashboard.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'special: the agent row is a grid row (role="row", tabIndex 0, J/K move and Enter opens), shown as clickable by cursor-pointer and hover. It holds its own Buttons (fixes, tray doors), so it cannot itself be a <button>.' },
    { file: 'components/Deck.tsx', rule: 'raw-button', count: 13, reason: 'debt: converts in the Deck PR' },
    { file: 'components/ErrorBoundary.tsx', rule: 'raw-button', count: 3, reason: 'debt: converts in the other windows PR' },
    { file: 'components/FlowEditorWindow.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the other windows PR' },
    { file: 'components/GenieBrowserChrome.tsx', rule: 'raw-button', count: 7, reason: 'debt: converts in the browser window PR' },
    { file: 'components/HostPathPicker.tsx', rule: 'raw-button', count: 5, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/IssueWatchPanel.tsx', rule: 'raw-anchor', count: 4, reason: 'debt: converts in the IssueWatch PR' },
    { file: 'components/IssueWatchPanel.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the IssueWatch PR' },
    { file: 'components/MobileShell.tsx', rule: 'raw-anchor', count: 2, reason: 'debt: converts in the mobile PWA PR' },
    { file: 'components/MobileShell.tsx', rule: 'raw-button', count: 16, reason: 'debt: converts in the mobile PWA PR' },
    { file: 'components/Onboarding.tsx', rule: 'raw-button', count: 4, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/PairPrompt.tsx', rule: 'raw-button', count: 4, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/PlanColumn.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'special: the plan column resize handle, a focusable role="separator" with aria-valuenow; double-click resets the width (Genie 1 gutter).' },
    { file: 'components/RelayConnecting.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/ShareWorkspaceModal.tsx', rule: 'raw-button', count: 2, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/StreamRow.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'special: link delegation on the prose cell for real <a> elements rendered by the markdown renderer (file, agent and workspace links). The row itself is a react-fancy Button when it is a control.' },
    { file: 'components/TitleBar.tsx', rule: 'raw-button', count: 6, reason: 'debt: converts in the workspace shell PR' },
    { file: 'components/TynnBoardPanel.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'special: role="menu" container only stops propagation so a click inside the menu does not close it.' },
    { file: 'components/TynnBoardPanel.tsx', rule: 'raw-button', count: 9, reason: 'debt: converts in the Tynn tab PR' },
    { file: 'components/TynnProjectLink.tsx', rule: 'raw-button', count: 3, reason: 'debt: converts in the Tynn tab PR' },
    { file: 'components/TynnProjectPicker.tsx', rule: 'raw-button', count: 2, reason: 'debt: converts in the Tynn tab PR' },
    { file: 'components/UpdateWindow.tsx', rule: 'raw-button', count: 2, reason: 'debt: converts in the other windows PR' },
    { file: 'components/WhatsNewWindow.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the other windows PR' },
    { file: 'components/Workspace.tsx', rule: 'raw-button', count: 32, reason: 'debt: converts in the workspace shell PR' },
    { file: 'components/WorkspaceColorPicker.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the workspace shell PR' },
    { file: 'components/WorkspaceTabs.tsx', rule: 'raw-button', count: 4, reason: 'debt: converts in the workspace shell PR' },
];
