import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `Modal` (@particle-academy/react-fancy, both 4.x and the installed 5.26.0)
 * has NO `title` prop. `ModalProps` only declares `open`, `onClose`, `size`,
 * `className` plus whatever `HTMLAttributes<HTMLDivElement>` spreads onto the
 * underlying `<div>` via `...rest`. `title` is a legal `HTMLAttributes`
 * member, so `<Modal title="...">` TYPE-CHECKS -- and does nothing useful: the
 * string lands on the div as a plain HTML tooltip attribute. No header
 * element is created, nothing reserves space at the top, and the first child
 * renders flush against the modal's edge (#320 -- NewAgentModal shipped with
 * no title bar and a clipped "Name" label).
 *
 * The supported API is composition: `Modal.Header` / `Modal.Body` /
 * `Modal.Footer`. `Modal.Header` also wires the close (X) button via
 * `useModal()`, which a `title=` string can never provide.
 *
 * This reads source rather than rendered output -- there is no DOM harness in
 * this lane for these components (see spec-menu-language.test.ts, which reads
 * SpecContextMenu.tsx the same way). The point is to fail the instant anyone,
 * anywhere in renderer/, reaches for `title=` on `<Modal>` again.
 */

const RENDERER_DIR = path.resolve(__dirname, '../..');

function allTsxFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...allTsxFiles(full));
        else if (entry.name.endsWith('.tsx')) out.push(full);
    }
    return out;
}

/**
 * Every `<Modal ...>` OPENING tag in `src` -- explicitly not `<Modal.Header>`,
 * `<Modal.Body>` or `<Modal.Footer>`, which are legitimate compound
 * components with their own prop signatures.
 */
function modalRootOpenTags(src: string): string[] {
    return [...src.matchAll(/<Modal(?![.\w])[^>]*>/g)].map((m) => m[0]);
}

describe('no <Modal> anywhere in renderer/ passes an unsupported title prop', () => {
    it('finds zero offenders across the whole renderer tree', () => {
        const offenders: string[] = [];
        for (const file of allTsxFiles(RENDERER_DIR)) {
            const src = fs.readFileSync(file, 'utf8');
            for (const tag of modalRootOpenTags(src)) {
                if (/\btitle=/.test(tag)) {
                    offenders.push(`${path.relative(RENDERER_DIR, file)}: ${tag}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('POSITIVE CONTROL: the scan itself finds <Modal> tags to check', () => {
        // If this drops to zero, the test above is vacuously green because it
        // never inspected anything -- not because the bug is fixed.
        let total = 0;
        for (const file of allTsxFiles(RENDERER_DIR)) {
            total += modalRootOpenTags(fs.readFileSync(file, 'utf8')).length;
        }
        expect(total).toBeGreaterThan(0);
    });
});

describe('NewAgentModal composes a real header instead of title=', () => {
    const SRC = fs.readFileSync(
        path.resolve(RENDERER_DIR, 'components/Master/NewAgentModal.tsx'),
        'utf8',
    );

    it('does not pass title= to <Modal>', () => {
        for (const tag of modalRootOpenTags(SRC)) {
            expect(tag).not.toMatch(/\btitle=/);
        }
    });

    it('renders the workspace-scoped title inside a real Modal.Header', () => {
        expect(SRC).toMatch(
            /<Modal\.Header>[^]*?New agent in \{workspaceName\}[^]*?<\/Modal\.Header>/,
        );
    });

    it('POSITIVE CONTROL: still composes Modal.Body and Modal.Footer, so Header is one piece of a real structure, not a rename that swallowed the rest', () => {
        expect(SRC).toMatch(/<Modal\.Body>/);
        expect(SRC).toMatch(/<Modal\.Footer>/);
    });
});

describe('FeedbackModal composes a real header instead of title=', () => {
    const SRC = fs.readFileSync(
        path.resolve(RENDERER_DIR, 'components/Master/FeedbackModal.tsx'),
        'utf8',
    );

    it('does not pass title= to <Modal>', () => {
        for (const tag of modalRootOpenTags(SRC)) {
            expect(tag).not.toMatch(/\btitle=/);
        }
    });

    it('renders "Send feedback" inside a real Modal.Header', () => {
        expect(SRC).toMatch(/<Modal\.Header>\s*Send feedback\s*<\/Modal\.Header>/);
    });

    it('POSITIVE CONTROL: still composes Modal.Body, so Header is a real addition, not the whole modal collapsed into one tag', () => {
        expect(SRC).toMatch(/<Modal\.Body>/);
    });
});
