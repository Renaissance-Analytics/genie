import { BrowserWindow, ipcMain } from 'electron';
import { getAllSettings, updateWorkspace } from '../db';
import { requestFeedback } from '../feedback-open';
import { isE2EMaster } from './mock';

/**
 * The Feedback hotkey spec (e2e/feedback-hotkey.spec.ts, genie#675).
 *
 * Runs on the REAL master window (the master fixture seeds it) with two things
 * stood in for, both of them the network:
 *
 *   - `tynn:projects` — the project picker's list. The E2E profile has no Tynn
 *     session, so the real handler lists nothing to pick.
 *   - `tynn:submit-feedback` — RECORDED, never sent. A test must not file
 *     anything into a real Tynn project.
 *
 * Scoped to its own flag on top of the master page, like the other page mocks:
 * the master-window spec keeps the real handlers.
 */

export const FEEDBACK_E2E_PROJECTS = [
    { id: 'PRJ-E2E-HOTKEY', name: 'Hotkey Project', slug: 'hotkey-project', backend: 'tynn' },
    { id: 'PRJ-E2E-OTHER', name: 'Other Project', slug: 'other-project', backend: 'tynn' },
];

export function isE2EFeedback(): boolean {
    return isE2EMaster() && process.env.GENIE_E2E_FEEDBACK === '1';
}

interface Submission {
    projectId: string;
    message: string;
    meta: Record<string, string>;
}

export function registerFeedbackE2EMocks(): void {
    const override: typeof ipcMain.handle = (channel, listener) => {
        ipcMain.removeHandler(channel as string);
        ipcMain.handle(channel as string, listener as never);
    };
    const submissions: Submission[] = [];

    override('tynn:projects', async () => FEEDBACK_E2E_PROJECTS);
    override(
        'tynn:submit-feedback',
        async (_e, projectId: string, message: string, meta: Record<string, string> = {}) => {
            submissions.push({ projectId, message, meta });
            return { ok: true, id: `e2e-feedback-${submissions.length}` };
        },
    );

    (globalThis as Record<string, unknown>).__GENIE_E2E_FEEDBACK__ = {
        submissions,
        /**
         * Link the ACTIVE workspace to a Tynn project, or unlink it (`null`). The
         * page reads the row on load, so the spec reloads after this.
         */
        linkActive: (project: { id: string; name: string } | null) => {
            const id = getAllSettings().active_workspace;
            if (!id) throw new Error('the master fixture pinned no active workspace');
            const row = updateWorkspace(
                id,
                project
                    ? { backend: 'tynn', tynn_project_id: project.id, tynn_project_name: project.name }
                    : { backend: 'none', tynn_project_id: id, tynn_project_name: '' },
            );
            if (!row) throw new Error(`no workspace row ${id} to link`);
        },
        /** What the global hotkey does once it reaches main: ask the window for Feedback. */
        press: () => {
            for (const win of BrowserWindow.getAllWindows()) requestFeedback(win);
        },
    };
}
