import { describe, expect, it } from 'vitest';
import ErrorBoundary from '../ErrorBoundary';
import { panelResetKeys } from '../../lib/panel-reset-keys';
import type { TerminalSpec } from '../../lib/genie';

type BoundaryProps = Parameters<ErrorBoundary['componentDidUpdate']>[0];

/**
 * The boundary's self-heal contract, exercised on the real class.
 *
 * There is no DOM harness in this suite (vitest runs the `node` environment),
 * so `componentDidUpdate` is driven directly with a recorded `setState` — which
 * is the whole of the reset logic: React only decides WHEN to call it.
 */
function boundaryInError(resetKeys: ReadonlyArray<unknown>) {
    const b = new ErrorBoundary({ children: null, resetKeys });
    b.state = { error: new Error('Maximum update depth exceeded'), info: null };
    const applied: unknown[] = [];
    (b as unknown as { setState: (s: unknown) => void }).setState = (s) => applied.push(s);
    return { b, applied };
}

/** Re-render the boundary with new resetKeys, as React would. */
function rerenderWith(b: ErrorBoundary, resetKeys: ReadonlyArray<unknown>) {
    const prev = b.props;
    (b as unknown as { props: BoundaryProps }).props = { children: null, resetKeys };
    b.componentDidUpdate(prev);
}

function codeSpec(id: string, file?: string): TerminalSpec {
    return {
        id,
        workspace_id: 'ws-a',
        label: 'Code',
        cwd: 'C:/repo',
        shell: null,
        args: [],
        env: {},
        type: 'code',
        meta: file ? { active_file: file } : {},
        sort_order: 0,
        created_at: '2026-07-01T00:00:00Z',
        last_opened_at: null,
        snapshot_at: null,
        snapshot_bytes: null,
        live_cwd: null,
        enabled: true,
    } as TerminalSpec;
}

describe('ErrorBoundary reset', () => {
    it('clears the error when resetKeys change', () => {
        const { b, applied } = boundaryInError(['view-1', 'ws-a', null]);
        rerenderWith(b, ['view-1', 'ws-b', null]);
        expect(applied).toEqual([{ error: null, info: null }]);
    });

    it('stays in the error state while resetKeys are unchanged', () => {
        const { b, applied } = boundaryInError(['view-1', 'ws-a', null]);
        rerenderWith(b, ['view-1', 'ws-a', null]);
        expect(applied).toEqual([]);
    });

    it('does nothing when there is no error to clear', () => {
        const b = new ErrorBoundary({ children: null, resetKeys: ['a'] });
        const applied: unknown[] = [];
        (b as unknown as { setState: (s: unknown) => void }).setState = (s) => applied.push(s);
        rerenderWith(b, ['b']);
        expect(applied).toEqual([]);
    });

    // The end-to-end contract for genie#68: a crashed editor panel heals when
    // the user switches workspace or file, and only then.
    it('heals a crashed panel on a workspace switch', () => {
        const spec = codeSpec('view-1', 'README.md');
        const { b, applied } = boundaryInError(panelResetKeys(spec, 'ws-a'));
        rerenderWith(b, panelResetKeys(spec, 'ws-b'));
        expect(applied).toEqual([{ error: null, info: null }]);
    });

    it('heals a crashed panel when the editor opens another file', () => {
        const { b, applied } = boundaryInError(
            panelResetKeys(codeSpec('view-1', 'README.md'), 'ws-a'),
        );
        rerenderWith(b, panelResetKeys(codeSpec('view-1', 'CHANGELOG.md'), 'ws-a'));
        expect(applied).toEqual([{ error: null, info: null }]);
    });

    it('does NOT heal on an unrelated re-render of the same panel', () => {
        const spec = codeSpec('view-1', 'README.md');
        const { b, applied } = boundaryInError(panelResetKeys(spec, 'ws-a'));
        rerenderWith(b, panelResetKeys(spec, 'ws-a'));
        expect(applied).toEqual([]);
    });
});
