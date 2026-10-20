import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AddWorkspacePreview } from '../src/renderer/components/AddWorkspacePreview.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';

/**
 * WORKSPACE OPERATIONS IN THE UI (§6.1). Adding a folder shows the PLAN before anything is written:
 * the folder, what Genie found it to be, every step with the ones that write marked, Confirm and
 * Cancel; a refusal shows the reason and offers only to pick again. The Workspace surface offers
 * Hibernate (or Wake, with an asleep banner) and Remove from Genie — the remove is confirmed on a
 * card that says the folder on disk is never touched and how many agents are forgotten.
 */

describe('AddWorkspacePreview', () => {
    it('shows the folder, its kind, each step with writes marked, and Confirm / Cancel', () => {
        const html = renderToStaticMarkup(
            <AddWorkspacePreview preview={{ ok: true, path: '/w/repo', kind: 'simple-repo', steps: [{ action: 'write project.json (host repo: this folder)', path: '/w/repo', writes: true }, { action: 'register in Genie', path: '/w/repo', writes: false }] }} onConfirm={() => {}} onCancel={() => {}} />,
        );
        expect(html).toContain('data-add-preview="simple-repo"');
        expect(html).toMatch(/\/w\/repo/);
        expect(html).toMatch(/a plain git repo/i);
        expect(html).toContain('data-step-writes="true"');
        expect(html).toContain('data-step-writes="false"');
        expect(html).toMatch(/write project\.json/);
        expect(html).toContain('data-action="confirm-add"');
        expect(html).toMatch(/>Cancel</);
    });

    it('a refusal shows the reason and no Confirm', () => {
        const html = renderToStaticMarkup(<AddWorkspacePreview preview={{ ok: false, reason: '/w/other is neither a repo nor an envelope; Genie will not guess what it is' }} onConfirm={() => {}} onCancel={() => {}} />);
        expect(html).toContain('data-add-preview="refused"');
        expect(html).toMatch(/will not guess/);
        expect(html).not.toContain('data-action="confirm-add"');
    });
});

const ops = (over: Partial<WorkspaceOpsProps> = {}): WorkspaceOpsProps => ({
    asleep: false, agentCount: 2, removePreview: false, lastOutcome: null,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    ...over,
});
const render = (o?: WorkspaceOpsProps) => renderToStaticMarkup(<Workspace workspace={{ id: 'tynn', path: '/w/tynn' }} terminals={NO_TERMINALS} ops={o} />);

describe('the Workspace surface', () => {
    it('without ops: no hibernate, no remove; with ops: Hibernate and Remove from Genie; asleep: a banner and Wake instead', () => {
        const none = render();
        expect(none).not.toContain('data-action="hibernate"');
        expect(none).not.toContain('data-action="remove-workspace"');
        const awake = render(ops());
        expect(awake).toContain('data-action="hibernate"');
        expect(awake).toContain('data-action="remove-workspace"');
        expect(awake).not.toContain('data-asleep');
        const asleep = render(ops({ asleep: true }));
        expect(asleep).toContain('data-asleep');
        expect(asleep).toMatch(/hibernating/);
        expect(asleep).toContain('data-action="wake"');
        expect(asleep).not.toContain('data-action="hibernate"');
    });

    it('the remove confirm says the folder is never touched and how many agents are forgotten; an outcome line shows the last result', () => {
        const html = render(ops({ removePreview: true }));
        expect(html).toContain('data-remove-confirm');
        expect(html).toMatch(/\/w\/tynn/);
        expect(html).toMatch(/is not touched/);
        expect(html).toMatch(/2 agents/);
        expect(html).toContain('data-action="confirm-remove"');
        expect(html).toMatch(/>Cancel</);
        expect(render(ops({ lastOutcome: 'hibernated; handoffs landed from atlas; none missing' }))).toMatch(/data-ops-outcome[^>]*>hibernated; handoffs landed from atlas/);
    });
});

// Tynn #839: Genie 1's "Share workspace…" from the workspace (v1 inventory row 116).
describe('Share… on the workspace', () => {
    it('offered when this Genie can share through Tynn', () => {
        expect(render(ops({ onShare: () => {} }))).toContain('data-action="share-workspace"');
    });

    it('not offered otherwise (CONTROL: a remote guest, a Genie with no Tynn)', () => {
        expect(render(ops())).not.toContain('data-action="share-workspace"');
    });
});
