import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InboxSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * THE AGENTINBOX SURFACE SENDS (§6.4): the human is a first-class participant. A composer with the
 * recipient (one of the reachable peers), the text, an Attach button that opens the host's picker, the
 * picked files listed by name (removable) — and every received attachment shown by name and size.
 */

const inbox: NonNullable<FeatureData['inbox']> = {
    unread: [{ seq: 1, id: 'msg_1', from: 'agent_a', to: 'human', text: 'done, see the diff', sentAt: 't', readAt: null, attachments: [{ id: 'att_1', name: 'diff.patch', size: 2048, sha256: 'abc' }] }] as never,
    peers: [{ address: 'claude:atlas', name: 'atlas', reachable: true }, { address: 'codex:bolt', name: 'bolt', reachable: false }],
};
const render = (compose?: { attachments: readonly string[]; onPick: () => void; onRemove: (path: string) => void }) =>
    renderToStaticMarkup(<InboxSurface data={{ ...EMPTY_FEATURES, inbox }} onAction={() => {}} onNavigate={() => {}} {...(compose ? { compose } : {})} />);

describe('AgentInbox surface', () => {
    it('shows each received attachment by name and size', () => {
        const html = render();
        expect(html).toContain('data-attachment="att_1"');
        expect(html).toMatch(/diff\.patch/);
        expect(html).toMatch(/2\.0 kB|2 kB/);
    });

    it('the composer names reachable peers only, offers Attach when a picker is wired, and lists picked files removably', () => {
        const html = render({ attachments: ['/w/tynn/notes.md', 'C:\\w\\tynn\\plan.pptx'], onPick: () => {}, onRemove: () => {} });
        expect(html).toContain('data-form="inbox-send"');
        expect(html).toMatch(/<option value="claude:atlas"/);
        expect(html).not.toMatch(/<option value="codex:bolt"/);
        expect(html).toContain('data-action="attach-files"');
        expect(html).toContain('data-attached="notes.md"');
        expect(html).toContain('data-attached="plan.pptx"');
        expect(html).toContain('data-action="remove-attachment"');
    });

    it('without a picker the composer still sends text; no Attach button, no empty file list', () => {
        const html = render();
        expect(html).toContain('data-form="inbox-send"');
        expect(html).not.toContain('data-action="attach-files"');
        expect(html).not.toContain('data-attached=');
    });
});
