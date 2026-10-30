import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { MobileAgent, MobileFileView, MobileFiles, MobileShell, MobileWorkspaces, PendingAttachments } from '../src/renderer/components/MobileShell.js';
import type { AgentDetail } from '../src/renderer/bridge.js';

/**
 * THE PHONE'S FIVE SURFACES (the owner, 2026-10-30): "the workspace selector, workstation dashboard, agent chat (with chat
 * stream) and a mobile friendly file browser and viewer with upload support. I need to be able to take photos and attach
 * as file to the chat as well." Nothing else — no terminal, no panel — and the inbox-upload form the old shell carried is
 * gone (a file goes to the chat or into the workspace now).
 */

const ws = [
    { id: 'tynn', path: '/w/tynn', name: 'Tynn', agentsKnown: true },
    { id: 'fancy', path: '/w/fancy', name: 'Fancy', agentsKnown: true, asleep: true },
];
const agent = (over: Partial<AgentRow>): AgentRow => ({
    id: 'agent_a', name: 'atlas', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working', duration: '2m', ask: null, reason: null, fixes: [], step: null,
    target: null, activity: null, delivery: null, collaborators: null, commsAgeSec: null, ...over,
} as AgentRow);
const agents = [agent({}), agent({ id: 'agent_w', name: 'wren', state: 'waiting', ask: 'Allow migrate?' }), agent({ id: 'agent_b', name: 'bolt', workspaceId: 'fancy', state: 'idle' })];
const item = (over: Partial<DeckItem> = {}): DeckItem => ({
    id: 'i1', source: 'agent-question', agentId: 'agent_w', agentName: 'wren', workspaceId: 'tynn', title: 'Allow php artisan migrate --force?', blocking: true, priority: 'normal', at: 1,
    answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }] }, forwardedFrom: null, ...over,
});

describe('1. the workspace selector', () => {
    it('All, then each workspace by NAME with how many agents and how many wait on you; the selected one is marked; asleep is said', () => {
        const html = renderToStaticMarkup(<MobileWorkspaces workspaces={ws} agents={agents} items={[item()]} selected="tynn" onSelect={() => {}} />);
        expect(html).toContain('data-mobile-ws="all"');
        expect(html).toMatch(/data-mobile-ws="tynn"[^>]*data-selected="true"/);
        expect(html).toMatch(/data-mobile-ws="fancy"[^>]*data-selected="false"/);
        expect(html).toContain('Tynn');
        expect(html).toMatch(/data-mobile-ws-waiting="tynn"[^>]*>1</);
        expect(html).toMatch(/data-mobile-ws-asleep="fancy"/);
        expect(html).not.toContain('/w/tynn');
    });
});

describe('2. the workstation dashboard', () => {
    const shell = (over: Partial<Parameters<typeof MobileShell>[0]> = {}) =>
        renderToStaticMarkup(<MobileShell host="alphar" locked={false} refusal={null} items={[item()]} answering={null} onAnswer={() => {}} onDisconnect={() => {}} workspaces={ws} agents={{ rows: agents, onOpen: () => {} }} selectedWorkspace={null} onSelectWorkspace={() => {}} onOpenFiles={() => {}} {...over} />);

    it('shows every agent with its state word; picking a workspace narrows agents AND what needs you to it', () => {
        const all = shell();
        expect(all).toContain('data-mobile-agent="agent_a"');
        expect(all).toContain('data-mobile-agent="agent_b"');
        expect(all).toMatch(/data-mobile-agent="agent_w"[^>]*data-state="waiting"/);
        const tynn = shell({ selectedWorkspace: 'fancy' });
        expect(tynn).toContain('data-mobile-agent="agent_b"');
        expect(tynn).not.toContain('data-mobile-agent="agent_a"');
        expect(tynn).not.toContain('data-mobile-item="i1"');
    });

    it('a workspace picked offers its Files; there is no inbox upload form, no terminal and no panel', () => {
        const html = shell({ selectedWorkspace: 'tynn' });
        expect(html).toContain('data-action="open-files"');
        expect(html).not.toContain('data-mobile-upload');
        expect(html).not.toMatch(/terminal/i);
        expect(html).not.toMatch(/data-panel/);
    });

    it('a dropped connection says Reconnecting over the last screen — never the pairing form', () => {
        const html = shell({ reconnecting: true });
        expect(html).toContain('data-mobile-reconnecting');
        expect(html).toContain('data-mobile="shell"');
        expect(html).not.toContain('data-mobile="pair"');
    });
});

describe('3. the agent chat and its stream', () => {
    const detail: AgentDetail = {
        agent: { id: 'agent_w', name: 'wren', provider: 'claude', fidelity: 'declared', cwd: '/w/tynn' },
        session: { status: 'waiting' } as never,
        rows: [
            { id: 'r1', at: 1, event: { kind: 'message', speaker: 'you', peerName: null, text: 'migrate the db' } },
            { id: 'r2', at: 2, event: { kind: 'message', speaker: 'agent', peerName: null, text: 'Running **migrations** now.' } },
        ] as never,
        turns: 1, cost: null, refusal: null,
    };
    const view = (over: Partial<Parameters<typeof MobileAgent>[0]> = {}) =>
        renderToStaticMarkup(<MobileAgent detail={detail} sending={false} onBack={() => {}} onSend={() => {}} onStart={() => {}} onResumeLimit={() => {}} needs={[item()]} answering={null} onAnswer={() => {}} {...over} />);

    it('the stream’s rows, and what this agent waits on you for — answerable right there', () => {
        const html = view();
        expect(html).toContain('data-mobile-row="r1"');
        expect(html).toContain('data-mobile-row="r2"');
        expect(html).toContain('data-mobile-waiting');
        expect(html).toContain('data-approval-option="allow"');
    });

    it('the composer takes a photo with the CAMERA, picks from the GALLERY, or attaches any file', () => {
        const html = view();
        expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="image\/\*"[^>]*capture="environment"[^>]*data-attach="camera"/);
        expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="image\/\*"[^>]*multiple=""[^>]*data-attach="gallery"/);
        expect(html).not.toMatch(/data-attach="gallery"[^>]*capture=/);
        expect(html).toMatch(/<input[^>]*type="file"[^>]*multiple=""[^>]*data-attach="file"/);
        expect(html).toContain('data-action="send-prompt"');
    });

    it('a picked photo shows as a chip that can be removed before sending', () => {
        const html = renderToStaticMarkup(<PendingAttachments files={[{ name: 'IMG_0001.jpg', size: 812_000 }]} onRemove={() => {}} />);
        expect(html).toContain('data-pending-attachment="IMG_0001.jpg"');
        expect(html).toContain('data-action="remove-attachment"');
    });
});

describe('4. the file browser and viewer', () => {
    it('lists a folder for the thumb: folders first, Up when inside one, and Upload / Take photo into this folder', () => {
        const html = renderToStaticMarkup(
            <MobileFiles workspaceName="Tynn" path="docs" entries={[{ id: 'docs/img', label: 'img', type: 'folder' }, { id: 'docs/a.md', label: 'a.md', type: 'file', ext: 'md' }]} onOpen={() => {}} onUp={() => {}} onUpload={() => {}} uploading={false} outcome={null} onBack={() => {}} />,
        );
        expect(html).toContain('data-mobile-files="docs"');
        expect(html).toMatch(/data-file-entry="docs\/img"[^>]*data-kind="folder"/);
        expect(html).toMatch(/data-file-entry="docs\/a.md"[^>]*data-kind="file"/);
        expect(html).toContain('data-action="up"');
        expect(html).toMatch(/<input[^>]*type="file"[^>]*multiple=""[^>]*data-action="upload"/);
        expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="image\/\*"[^>]*capture="environment"[^>]*data-action="upload-photo"/);
    });

    it('null entries is "not read yet" (a skeleton), [] is a sentence', () => {
        const props = { workspaceName: 'Tynn', path: '', onOpen: () => {}, onUp: () => {}, onUpload: () => {}, uploading: false, outcome: null, onBack: () => {} };
        expect(renderToStaticMarkup(<MobileFiles {...props} entries={null} />)).toContain('data-mobile-files-loading');
        expect(renderToStaticMarkup(<MobileFiles {...props} entries={[]} />)).toContain('data-mobile-files-empty');
    });

    it('previews markdown rendered, code as text, an image as an image, a PDF to open, a refusal in words', () => {
        const md = renderToStaticMarkup(<MobileFileView path="README.md" preview={{ kind: 'markdown', text: '# Title\n\nsome **bold**' }} onBack={() => {}} />);
        expect(md).toContain('<strong>bold</strong>');
        const code = renderToStaticMarkup(<MobileFileView path="a.ts" preview={{ kind: 'text', text: 'const a = <b>;' }} onBack={() => {}} />);
        expect(code).toContain('data-preview="text"');
        expect(code).toContain('const a = &lt;b&gt;;');
        const img = renderToStaticMarkup(<MobileFileView path="p.png" preview={{ kind: 'image', url: 'blob:x' }} onBack={() => {}} />);
        expect(img).toMatch(/<img[^>]*src="blob:x"/);
        const pdf = renderToStaticMarkup(<MobileFileView path="s.pdf" preview={{ kind: 'pdf', url: 'blob:y' }} onBack={() => {}} />);
        expect(pdf).toMatch(/<a[^>]*href="blob:y"[^>]*data-action="open-pdf"/);
        const bad = renderToStaticMarkup(<MobileFileView path="big.log" preview={{ kind: 'error', reason: 'big.log is 12 MB; the limit is 8 MB' }} onBack={() => {}} />);
        expect(bad).toContain('the limit is 8 MB');
    });
});
