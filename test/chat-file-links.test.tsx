import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fileLinkTarget, linkFileRefs } from '../src/core/chat-file-links.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * A FILE NAMED IN CHAT IS A LINK THAT OPENS IT, WITH THE TREE SYNCED (the owner, 2026-10-19: "if I click a link to a
 * file in chat it should open that file with the file tree synced"). The chat had no file links at all. A reference is
 * recognised by Genie 1's rule (core/ask-file-refs.ts: a path WITH a separator, optionally `:line`; never a bare name,
 * never inside a URL) and becomes a `#file:` link; clicking it opens the file in the chat agent's workspace, at the line,
 * and the panel reveals it (core/files-tree-lazy.ts revealFor).
 */
describe('linkFileRefs — the message, with every file reference a link', () => {
    it('a path in prose and a path in code both become links, with the line kept', () => {
        const md = 'I changed src/core/route.ts and `src/main/files-host.ts:42`.';
        const out = linkFileRefs(md);
        expect(out).toContain('[src/core/route.ts](#file:src/core/route.ts)');
        expect(out).toContain('[`src/main/files-host.ts:42`](#file:src/main/files-host.ts:42)');
    });

    it('NOT links: a bare name, a URL, an existing link, anything in a fenced block (COUNTED: none added)', () => {
        const md = [
            'See package.json and https://example.com/src/a.ts and [the doc](docs/x.md).',
            '```',
            'cat src/core/route.ts',
            '```',
        ].join('\n');
        expect(linkFileRefs(md)).toBe(md);
    });

    it('fileLinkTarget reads a link back: the path and the line; anything else is not a file link', () => {
        expect(fileLinkTarget('#file:src/main/files-host.ts:42')).toEqual({ path: 'src/main/files-host.ts', line: 42 });
        expect(fileLinkTarget('#file:src/core/route.ts')).toEqual({ path: 'src/core/route.ts', line: null });
        expect(fileLinkTarget('https://example.com')).toBeNull();
        expect(fileLinkTarget('#section')).toBeNull();
    });
});

describe('the chat draws them as links (through Fancy’s sanitising renderer)', () => {
    const thread: ChatThread = {
        agentId: 'a1', name: 'atlas', fidelity: 'declared', unread: null,
        messages: [{ id: 'm1', from: 'atlas', who: 'agent', text: 'Fixed `src/core/route.ts:42`.', delivered: true }],
    };

    it('an agent message names a file: an anchor to it survives the renderer', () => {
        const html = renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} onOpenFile={() => {}} />);
        expect(html).toContain('href="#file:src/core/route.ts:42"');
    });

    it('CONTROL: with no file opener (nowhere to open it), the text is left as it was', () => {
        const html = renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} />);
        expect(html).not.toContain('#file:');
    });
});
