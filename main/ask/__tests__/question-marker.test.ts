import { describe, expect, it } from 'vitest';
import { questionMarkWorkspace } from '../force-question';

/**
 * Which workspace row gets the yellow `?` when a question is raised.
 *
 * Extracted as a PURE decision for the same reason `tailscale-panel.ts` and
 * `apps/panels.ts` are: the rule has two branches that matter and the function
 * that applies it (`enqueue`) can only run with a real BrowserWindow. Testing the
 * decision here means both branches are covered without opening a window on
 * anyone's desktop.
 */
describe('the question marker belongs to the asking workspace', () => {
    it('names the workspace a LOCAL agent asked from', () => {
        expect(questionMarkWorkspace({ workspaceId: 'ws-1' })).toBe('ws-1');
    });

    it('marks NOTHING for a question FORWARDED from a host', () => {
        // A forwarded question was raised by an agent on the HOST. Its pulse
        // already travels here on `agent-pulse`, which is in PASSTHROUGH_EVENTS —
        // so marking it locally would draw the same question twice: once from the
        // host's own marker and once from this driver's re-derivation.
        expect(
            questionMarkWorkspace({
                workspaceId: 'ws-1',
                forward: { connKey: 'c1', hostId: 'h1' },
            }),
        ).toBeNull();
        // Positive control: the SAME item without `forward` does mark, so the
        // null above is the forwarding and not a function that always refuses.
        expect(questionMarkWorkspace({ workspaceId: 'ws-1' })).toBe('ws-1');
    });

    it('marks nothing when the asker has no workspace at all', () => {
        expect(questionMarkWorkspace({})).toBeNull();
        expect(questionMarkWorkspace({ workspaceId: '' })).toBeNull();
        expect(questionMarkWorkspace({ workspaceId: '   ' })).toBeNull();
    });
});
