import { checkBeforeSend, crashReportText, crashSignatures, redactCrashText, type CrashFacts, type RedactionContext } from '../core/crash-report.js';
import type { SafeModeView } from '../core/safe-mode.js';
import type { HangNotice } from '../core/crash-record.js';

/**
 * THE CRASH REPORT'S TWO STEPS IN THE WINDOW'S MAIN PROCESS (Tynn #386 part 4): the DRAFT the safe-mode banner shows —
 * built from the crash's facts and redacted — and the SEND, only when the person presses it, to Tynn's
 * `POST /api/v1/workstations/{id}/crash-reports` with this workstation's host proof (Tynn #387). Tynn redacts again,
 * dedupes and files it on fow-support, and answers the issue's URL.
 *
 * Not signed in or not enrolled with Tynn (no workstation identity, or Tynn's 404 for an unknown proof): `signIn`, so the
 * banner says so and offers a Copy — never a silent failure. Text that redaction would change is not sent: the cleaned
 * text comes back to be looked at again.
 */
export interface CrashReportDeps {
    readonly view: () => SafeModeView | null;
    /** The latest crash record the host sent (Tynn #386 cut 3). Not read yet. */
    readonly record?: () => unknown;
    /** The reopened-window notice, when there is one. Not read yet. */
    readonly notice?: () => HangNotice | null;
    /** Every registered agent: their names are redacted, their providers counted. */
    readonly agents: () => readonly { readonly id: string; readonly name: string; readonly provider: string }[];
    /** Every workspace name Genie knows (names, slugs, folder names): redacted. */
    readonly workspaceNames: () => readonly string[];
    readonly genieVersion: string;
    readonly os: string;
    readonly arch: string;
    readonly tynnHost: string;
    readonly identity: () => Promise<{ workstationId: string } | null>;
    readonly authHeader: () => Promise<string>;
    readonly fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;
}

export type CrashSendAnswer = { ok: true; issueUrl: string } | { ok: false; reason: string; signIn?: boolean; cleaned?: string };

const NOT_SIGNED_IN = 'Sign in to Tynn to send this report';
/** Tynn needs a stack: a crash record without one (before the hang watchdog's) says so. */
const stackOrNone = (s: string[]): string[] => (s.length > 0 ? s : ['(no stack recorded)']);

export function crashReportHost(deps: CrashReportDeps) {
    const ctx = (): RedactionContext => ({ workspaceNames: deps.workspaceNames(), agentNames: deps.agents().map((a) => a.name) });
    const facts = (): CrashFacts | null => {
        const view = deps.view();
        if (!view?.active) return null;
        const byId = new Map(deps.agents().map((a) => [a.id, a.provider]));
        return { view, genieVersion: deps.genieVersion, os: deps.os, arch: deps.arch, providers: view.agents.map((id) => byId.get(id) ?? 'unknown') };
    };
    return {
        /** The text the person is shown: built, then redacted. */
        draft(): { text: string } {
            const f = facts();
            return { text: f ? redactCrashText(crashReportText(f), ctx()) : '' };
        },
        async send(text: string, notes: string): Promise<CrashSendAnswer> {
            const f = facts();
            if (!f) return { ok: false, reason: 'There is no crash to report.' };
            const checked = checkBeforeSend(text, ctx());
            if (!checked.ok) return { ok: false, reason: checked.reason, cleaned: checked.text };
            const notesChecked = checkBeforeSend(notes, ctx());
            if (!notesChecked.ok) return { ok: false, reason: 'Genie removed private details from what you were doing. Check it, then Send again.', cleaned: text };
            const id = await deps.identity().catch(() => null);
            if (!id) return { ok: false, reason: NOT_SIGNED_IN, signIn: true };
            let res: { status: number; json(): Promise<unknown> };
            try {
                res = await deps.fetch(`${deps.tynnHost}/api/v1/workstations/${encodeURIComponent(id.workstationId)}/crash-reports`, {
                    method: 'POST',
                    headers: { Authorization: await deps.authHeader(), 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({ kind: f.view.cause, genieVersion: f.genieVersion, platform: `${f.os}-${f.arch}`, message: text, stack: stackOrNone(crashSignatures(f).map((s) => redactCrashText(s, ctx()))), notes }),
                });
            } catch (error) {
                return { ok: false, reason: `Tynn could not be reached: ${error instanceof Error ? error.message : String(error)}` };
            }
            // Tynn answers every unauthorized call with a 404: this workstation is not one it knows.
            if (res.status === 404) return { ok: false, reason: NOT_SIGNED_IN, signIn: true };
            const body = (await res.json().catch(() => ({}))) as { ok?: boolean; issueUrl?: string; reason?: string };
            if (res.status === 200 && body.ok && typeof body.issueUrl === 'string') return { ok: true, issueUrl: body.issueUrl };
            return { ok: false, reason: body.reason ?? `Tynn refused the report (HTTP ${res.status}).` };
        },
    };
}
