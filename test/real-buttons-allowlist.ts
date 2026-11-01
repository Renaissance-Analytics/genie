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
    { file: 'components/AgentView.tsx', rule: 'raw-button', count: 30, reason: 'debt: converts in the Agent view PR' },
    { file: 'components/AgiRemoteChoice.tsx', rule: 'raw-button', count: 9, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/AlertToasts.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the chat/stream PR' },
    { file: 'components/AppInboxCard.tsx', rule: 'raw-button', count: 5, reason: 'debt: converts in the inbox/questions PR' },
    { file: 'components/ApprovalCard.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the chat/stream PR' },
    { file: 'components/ChatFlyout.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'special: link delegation on the chat log. The click targets are real <a> elements rendered by the markdown renderer (file, agent and workspace links); the container only routes them in-app.' },
    { file: 'components/ChatFlyout.tsx', rule: 'raw-button', count: 12, reason: 'debt: converts in the chat/stream PR' },
    { file: 'components/ChatProse.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'special: stopCopyClick only stops a click on the copy control from reaching the row (no action of its own).' },
    { file: 'components/ChatProse.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the chat/stream PR' },
    { file: 'components/ConnectMenu.tsx', rule: 'raw-button', count: 10, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/Dashboard.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'debt: converts in the Dashboard PR' },
    { file: 'components/Dashboard.tsx', rule: 'raw-button', count: 11, reason: 'debt: converts in the Dashboard PR' },
    { file: 'components/Deck.tsx', rule: 'raw-button', count: 13, reason: 'debt: converts in the Deck PR' },
    { file: 'components/DesignedTab.tsx', rule: 'raw-button', count: 5, reason: 'debt: converts in the files/editor PR' },
    { file: 'components/DocumentEditor.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the files/editor PR' },
    { file: 'components/ErrorBoundary.tsx', rule: 'raw-button', count: 3, reason: 'debt: converts in the other windows PR' },
    { file: 'components/FeatureSurfaces.tsx', rule: 'raw-anchor', count: 1, reason: 'debt: converts in the Hosting, Toolchain, Flows, Settings (FeatureSurfaces) PR' },
    { file: 'components/FeatureSurfaces.tsx', rule: 'raw-button', count: 103, reason: 'debt: converts in the Hosting, Toolchain, Flows, Settings (FeatureSurfaces) PR' },
    { file: 'components/FileOpModal.tsx', rule: 'raw-button', count: 2, reason: 'debt: converts in the files/editor PR' },
    { file: 'components/FilesPanel.tsx', rule: 'raw-button', count: 21, reason: 'debt: converts in the files/editor PR' },
    { file: 'components/FlowEditorWindow.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the other windows PR' },
    { file: 'components/GenieBrowserChrome.tsx', rule: 'raw-button', count: 7, reason: 'debt: converts in the browser window PR' },
    { file: 'components/HostPathPicker.tsx', rule: 'raw-button', count: 5, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/ImportedAgents.tsx', rule: 'raw-button', count: 2, reason: 'debt: converts in the Dashboard PR' },
    { file: 'components/InboxFlyout.tsx', rule: 'raw-anchor', count: 1, reason: 'debt: converts in the inbox/questions PR' },
    { file: 'components/InboxFlyout.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the inbox/questions PR' },
    { file: 'components/Inspector.tsx', rule: 'raw-button', count: 3, reason: 'debt: converts in the Agent view PR' },
    { file: 'components/IssueWatchPanel.tsx', rule: 'raw-anchor', count: 4, reason: 'debt: converts in the IssueWatch PR' },
    { file: 'components/IssueWatchPanel.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the IssueWatch PR' },
    { file: 'components/Lanes.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the Dashboard PR' },
    { file: 'components/MobileShell.tsx', rule: 'raw-anchor', count: 2, reason: 'debt: converts in the mobile PWA PR' },
    { file: 'components/MobileShell.tsx', rule: 'raw-button', count: 16, reason: 'debt: converts in the mobile PWA PR' },
    { file: 'components/NewAgentModal.tsx', rule: 'raw-button', count: 2, reason: 'debt: converts in the Agent view PR' },
    { file: 'components/Onboarding.tsx', rule: 'raw-button', count: 4, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/PairPrompt.tsx', rule: 'raw-button', count: 4, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/PlanColumn.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'special: the plan column resize handle, a focusable role="separator" with aria-valuenow; double-click resets the width (Genie 1 gutter).' },
    { file: 'components/PlanColumn.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the Dashboard PR' },
    { file: 'components/QuestionApp.tsx', rule: 'raw-button', count: 4, reason: 'debt: converts in the inbox/questions PR' },
    { file: 'components/QuestionForm.tsx', rule: 'raw-button', count: 4, reason: 'debt: converts in the inbox/questions PR' },
    { file: 'components/RelayConnecting.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/ShareWorkspaceModal.tsx', rule: 'raw-button', count: 3, reason: 'debt: converts in the add workspace/onboarding PR' },
    { file: 'components/Sidebar.tsx', rule: 'click-on-non-interactive', count: 2, reason: 'debt: converts in the workspace shell PR' },
    { file: 'components/Sidebar.tsx', rule: 'raw-button', count: 9, reason: 'debt: converts in the workspace shell PR' },
    { file: 'components/Sidebar.tsx', rule: 'role-button', count: 2, reason: 'debt: converts in the workspace shell PR' },
    { file: 'components/SitePanel.tsx', rule: 'raw-button', count: 3, reason: 'debt: converts in the Hosting/sites PR' },
    { file: 'components/Stream.tsx', rule: 'raw-button', count: 4, reason: 'debt: converts in the chat/stream PR' },
    { file: 'components/StreamRow.tsx', rule: 'click-on-non-interactive', count: 2, reason: 'mixed: 1 special (line ~110, link delegation for real <a> in rendered markdown) + 1 debt (the inspectable/expandable row is a div with role=button; becomes a Button) — chat/stream PR.' },
    { file: 'components/StreamRow.tsx', rule: 'role-button', count: 1, reason: 'debt: converts in the chat/stream PR' },
    { file: 'components/TerminalCell.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the Agent view PR' },
    { file: 'components/TimelineStrip.tsx', rule: 'raw-button', count: 6, reason: 'debt: converts in the Dashboard PR' },
    { file: 'components/TitleBar.tsx', rule: 'raw-button', count: 6, reason: 'debt: converts in the workspace shell PR' },
    { file: 'components/TurnCards.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the chat/stream PR' },
    { file: 'components/TurnStop.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the chat/stream PR' },
    { file: 'components/TynnBoardPanel.tsx', rule: 'click-on-non-interactive', count: 1, reason: 'special: role="menu" container only stops propagation so a click inside the menu does not close it.' },
    { file: 'components/TynnBoardPanel.tsx', rule: 'raw-button', count: 9, reason: 'debt: converts in the Tynn tab PR' },
    { file: 'components/TynnProjectLink.tsx', rule: 'raw-button', count: 3, reason: 'debt: converts in the Tynn tab PR' },
    { file: 'components/TynnProjectPicker.tsx', rule: 'raw-button', count: 2, reason: 'debt: converts in the Tynn tab PR' },
    { file: 'components/UpdateWindow.tsx', rule: 'raw-button', count: 2, reason: 'debt: converts in the other windows PR' },
    { file: 'components/WhatsNewWindow.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the other windows PR' },
    { file: 'components/Workspace.tsx', rule: 'raw-button', count: 32, reason: 'debt: converts in the workspace shell PR' },
    { file: 'components/WorkspaceColorPicker.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the workspace shell PR' },
    { file: 'components/WorkspaceRuntimeModal.tsx', rule: 'raw-button', count: 1, reason: 'debt: converts in the Hosting/sites PR' },
    { file: 'components/WorkspaceTabs.tsx', rule: 'raw-button', count: 4, reason: 'debt: converts in the workspace shell PR' },
];
