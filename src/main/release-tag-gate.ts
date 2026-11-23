import { judgeReleaseDecision, releaseDecisionPath, type ReleaseGate, type TagOptions, type TagVersion } from '../core/release-tag.js';
import { bodyOf, readTynnBoard, refusal, SIGNED_OUT, type TynnBoardPorts } from './tynn-board-client.js';

/**
 * PM G-4 (Tynn #937): WHAT THE TAG STEP ASKS TYNN, for a workspace linked to it. Through the person's pairing (the same
 * ports as the Tynn tab), on the project the workspace's project.json names — the caller reads that link, so a workspace
 * cannot be "unlinked" by an account that is merely signed out. Every way of not getting a decision is a refusal: no
 * account, signed out, Tynn refusing, Tynn unreachable. Linked work FAILS CLOSED; only an unlinked workspace has no gate.
 */

const NO_ACCOUNT = 'Genie has no Tynn account to ask for the release decision. Sign in to Tynn (Settings → Accounts → Tynn), then tag again.';
const HIDDEN = 'Tynn did not show this version\'s release decision to this Genie: the version may not be in this project, or the pairing does not include the board. Sign in to Tynn again (Settings → Accounts → Tynn), then tag again.';

export async function releaseDecisionGate(ports: TynnBoardPorts | null, projectId: string, versionId: string, commit: string): Promise<ReleaseGate> {
    if (!ports) return { ok: false, reason: NO_ACCOUNT };
    if (!ports.signedIn()) return { ok: false, reason: SIGNED_OUT.reason };
    let res;
    try { res = await ports.request(releaseDecisionPath(projectId, versionId, commit), { method: 'GET' }); }
    catch (error) { return { ok: false, reason: `Genie could not ask Tynn for the release decision: ${error instanceof Error ? error.message : String(error)}` }; }
    if (!res.ok) return { ok: false, reason: res.status === 404 || res.status === 401 || res.status === 403 ? HIDDEN : (await refusal(res)).reason };
    return judgeReleaseDecision(await bodyOf(res), { versionId, commit });
}

/** The versions a tag can release: those still to be released, the one in flight first (Tynn's order within a state). */
const OFFERED = ['active', 'review', 'accepted', 'draft'] as const;

/** The Tag release form's Tynn half: the project's versions still to release, or why there are none to offer. */
export async function tagVersions(ports: TynnBoardPorts | null, workspaceId: string, projectId: string): Promise<Pick<TagOptions, 'versions' | 'reason'>> {
    if (!ports) return { versions: [], reason: NO_ACCOUNT };
    const board = await readTynnBoard({ ...ports, projectFor: () => projectId }, workspaceId, {});
    if (!board.ok) return { versions: [], reason: board.reason };
    const versions: TagVersion[] = [];
    for (const state of OFFERED) {
        for (const card of board.view.cards) {
            if (card.kind === 'version' && card.status === state) versions.push({ id: card.id, number: card.number, title: card.title, status: card.status });
        }
    }
    return { versions, reason: versions.length === 0 ? 'Tynn has no version still to release in this project.' : null };
}
