// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { FlowRecord } from '../src/main/flow-store.js';
import { NO_FILES } from '../src/renderer/bridge.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';
import { FilesWindow, type FilesWindowProps } from '../src/renderer/components/FilesWindow.js';
import { FlowEditorWindow, type FlowEditorWindowProps } from '../src/renderer/components/FlowEditorWindow.js';

vi.mock('../src/renderer/components/FilesPanelContainer.js', () => ({
    FilesPanelContainer: ({ visible = true }: { visible?: boolean }) => <textarea data-kept-editor="" data-visible={String(visible)} defaultValue="Unsaved local text" />,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); root = null; document.body.innerHTML = ''; });
const mount = () => { const node = document.createElement('div'); document.body.append(node); root = createRoot(node); return node; };

it('story394: an open Files window hides on hibernation without discarding its unsaved editor buffer', () => {
    const node = mount();
    const workspace = { id: 'ghost', path: '/ghost', name: 'Named project' };
    const render = (asleep: boolean) => act(() => root!.render(<FilesWindow {...{ workspace: asleep ? null : workspace, hibernated: asleep, files: NO_FILES, onBringBack: () => {} } as FilesWindowProps} />));
    render(false);
    const editor = node.querySelector<HTMLTextAreaElement>('[data-kept-editor]')!;
    expect(editor.value).toBe('Unsaved local text'); editor.value = 'The person’s unfinished edit';
    render(true);
    expect(editor.isConnected).toBe(true); expect(editor.closest('[hidden]')).not.toBeNull();
    expect(editor.dataset.visible).toBe('false'); expect(node.textContent).toMatch(/hibernat.*redock/i);
    render(false);
    expect(node.querySelector('[data-kept-editor]')).toBe(editor);
    expect(editor.closest('[hidden]')).toBeNull(); expect(editor.value).toBe('The person’s unfinished edit');
    expect(editor.dataset.visible).toBe('true');
});

it('story394: a Flow editor hides its cached graph while hibernated and keeps the unsaved graph for redock', () => {
    const node = mount();
    const flow = { id: 'flow-kept', workspaceId: 'ghost', name: 'Kept flow', document: { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [{ id: 'trigger', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 * * * *', timezone: 'UTC' } }], edges: [] } }, armed: false, createdBy: { kind: 'user' }, createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z', refusals: [], runs: [] } as FlowRecord;
    const Editor = (props: Record<string, unknown>) => {
        const value = props.value as { nodes: Array<{ position: { x: number; y: number } }> };
        return <div data-kept-flow=""><span>{value.nodes[0]!.position.x}</span><button onClick={() => (props.onChange as (graph: unknown) => void)({ ...value, nodes: value.nodes.map((n) => ({ ...n, position: { ...n.position, x: 42 } })) })}>Move node</button></div>;
    };
    const render = (asleep: boolean) => act(() => root!.render(<FlowEditorWindow {...{ flowId: flow.id, workspaceId: null, hibernated: asleep, data: { ...EMPTY_FEATURES, flows: { flows: asleep ? [] : [flow], adding: null } }, workspaces: asleep ? [] : [{ id: 'ghost', path: '/ghost' }], act: vi.fn(), Editor } as unknown as FlowEditorWindowProps} />));
    render(false); act(() => node.querySelector<HTMLButtonElement>('[data-kept-flow] button')!.click());
    const editor = node.querySelector('[data-kept-flow]')!; expect(editor.textContent).toContain('42');
    render(true);
    expect(editor.isConnected).toBe(true); expect(editor.closest('[hidden]')).not.toBeNull(); expect(node.textContent).toMatch(/hibernat.*redock/i);
    render(false); expect(node.querySelector('[data-kept-flow]')).toBe(editor); expect(editor.textContent).toContain('42');
    expect(editor.closest('[hidden]')).toBeNull();
});
