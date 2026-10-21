import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { importedAgents } from '../src/core/agent-adoption.js';
import { ImportedAgentsView } from '../src/renderer/components/ImportedAgents.js';

/**
 * "IT CAME WITH AGENTS" ON SCREEN (Add workspace parity item 6; Genie 1's WorkspaceBroughtAgents + ImportedAgents): after an
 * add, the agents the workspace brought, each with Adopt — or the reason it cannot be adopted — and Open workspace. Offered,
 * never automatic; Genie reads the file and never rewrites it, and says so.
 */

type Props = Record<string, unknown> & { children?: ReactNode };
function findAll(node: ReactNode, match: (p: Props) => boolean, out: Props[] = []): Props[] {
    if (Array.isArray(node)) { for (const n of node) findAll(n, match, out); return out; }
    if (!isValidElement(node)) return out;
    const props = node.props as Props;
    if (match(props)) out.push(props);
    findAll(props.children, match, out);
    return out;
}
const noop = () => {};
const agents = importedAgents({ files: [{ folder: 'atlas', text: '' }, { folder: 'bolt', text: '---\ntuis: [codex]\n---' }, { folder: 'tynn', text: '' }], registered: [] });
const base = { workspaceName: 'Acme', path: '/w/acme.agi', agents, busy: null, notice: null, error: null, onAdopt: noop, onOpen: noop };

describe('the workspace came with agents', () => {
    it('says what happened, in Genie 1’s words, and lists every file — an Adopt for each one Genie can take (COUNTED: two)', () => {
        const html = renderToStaticMarkup(<ImportedAgentsView {...base} />);
        expect(html).toContain('Acme is ready — and it came with agents');
        expect(html).toContain('3 agents already belong to this project and are not registered on this machine.');
        expect(html).toContain('Genie reads its file, it never rewrites it');
        expect(html.match(/data-action="adopt-agent"/g)?.length).toBe(2);
        expect(html).toMatch(/data-imported-agent="bolt"[\s\S]*?codex/);
        // The refused one is shown with its reason and no Adopt.
        expect(html).toMatch(/data-imported-agent="tynn"[\s\S]*?reserved name/);
        expect(html).not.toMatch(/data-action="adopt-agent"[^>]*data-agent="tynn"/);
        expect(html).toContain('data-action="open-workspace"');
    });

    it('Adopt adopts THAT agent; Open workspace opens it', () => {
        const did: string[] = [];
        const ui = ImportedAgentsView({ ...base, onAdopt: (n) => did.push(`adopt:${n}`), onOpen: () => did.push('open') });
        for (const b of findAll(ui, (p) => p['data-action'] === 'adopt-agent' || p['data-action'] === 'open-workspace')) (b.onClick as () => void)();
        expect(did.sort()).toEqual(['adopt:atlas', 'adopt:bolt', 'open']);
    });

    it('while one is being adopted its button says so and every Adopt waits; the result and Tynn-free errors are shown', () => {
        const html = renderToStaticMarkup(<ImportedAgentsView {...base} busy="atlas" notice="atlas is registered. Its .agents/atlas/AGENT.md was read, not rewritten." error="acme already has an agent named bolt" />);
        expect(html).toMatch(/data-agent="atlas"[^>]*disabled=""[^>]*>[\s\S]*?Adopting…/);
        expect(html).toMatch(/data-agent="bolt"[^>]*disabled=""/);
        expect(html).toContain('atlas is registered. Its .agents/atlas/AGENT.md was read, not rewritten.');
        expect(html).toContain('acme already has an agent named bolt');
    });

    it('once all are adopted the screen stays as the confirmation, with nothing left to press but Open', () => {
        const html = renderToStaticMarkup(<ImportedAgentsView {...base} agents={[]} notice="bolt is registered." />);
        expect(html).toContain('bolt is registered.');
        expect(html).not.toContain('data-action="adopt-agent"');
        expect(html).toContain('data-action="open-workspace"');
    });
});
