import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TrustStepBody } from '../src/renderer/components/TrustStep.js';
import type { TrustStepView } from '../src/renderer/features.js';

/** THE TRUST STEP: what would run, and the person's yes. Its action through the real composition is in workspace-trust-wiring.test.ts. */

const EMPTY = { sites: [], hooks: [], servers: [], gitKeys: [], approvals: [] };
const step = (over: Partial<TrustStepView> = {}, list: Partial<TrustStepView['list']> = {}): TrustStepView => ({ workspaceId: 'acme', changed: false, list: { ...EMPTY, ...list }, ...over });
const body = (view: TrustStepView, phase: { kind: 'idle' } | { kind: 'pending' } | { kind: 'failed'; reason: string } = { kind: 'idle' }) => renderToStaticMarkup(<TrustStepBody step={view} phase={phase} onTrust={vi.fn()} />);

describe('what it shows', () => {
    it('each thing that would run, whole, by kind', () => {
        const html = body(step({}, {
            sites: [{ key: 'k', fingerprint: 'f', runs: 'php artisan serve --port 9000', folder: 'repos/one', npmScript: null }],
            hooks: [{ file: '.claude/settings.json', event: 'Stop', command: 'curl example.invalid/hook' }],
            servers: [{ file: '.mcp.json', name: 'theirs', command: 'node server.js' }],
            gitKeys: [{ key: 'core.fsmonitor', value: './watch.sh' }],
            approvals: ['Bash(npm run build)'],
        }));
        for (const words of ['php artisan serve --port 9000', 'repos/one', '.claude/settings.json', 'curl example.invalid/hook', 'theirs', 'node server.js', 'core.fsmonitor', './watch.sh', 'Bash(npm run build)']) {
            expect(html).toContain(words);
        }
    });

    it('a site that runs an npm script shows that script, and says it is npm only', () => {
        const html = body(step({}, { sites: [{ key: 'k', fingerprint: 'f', runs: 'npm run dev', folder: '.', npmScript: 'vite --host' }] }));
        expect(html).toContain('vite --host');
        expect(html).toMatch(/data-trust-npm-note/);
    });

    it('no npm note where no site has a script', () => {
        expect(body(step({}, { sites: [{ key: 'k', fingerprint: 'f', runs: 'php -S x', folder: '.', npmScript: null }] }))).not.toMatch(/data-trust-npm-note/);
    });

    it('it says what an agent cannot read until then', () => {
        expect(body(step())).toMatch(/data-trust-agents-note/);
    });

    it('nothing listed: it says so, and the yes is still there', () => {
        const html = body(step());
        expect(html).toMatch(/data-trust-nothing-listed/);
        expect(html).toMatch(/data-action="trust-workspace"/);
    });

    it('first time and changed since are different words, and changed says what becomes of a running agent', () => {
        expect(body(step())).toMatch(/data-trust-first/);
        expect(body(step())).not.toMatch(/data-trust-changed/);
        const changed = body(step({ changed: true }));
        expect(changed).toMatch(/data-trust-changed/);
        expect(changed).toContain('keep their conversations');
    });
});

describe('the yes shows progress, then what happened', () => {
    it('ready: enabled', () => {
        expect(body(step())).not.toMatch(/data-action="trust-workspace"[^>]*disabled/);
    });

    it('in flight: it cannot be pressed twice', () => {
        const html = body(step(), { kind: 'pending' });
        expect(html).toMatch(/data-trust-busy/);
        expect(html).toMatch(/<button[^>]*disabled/);
    });

    it('failed: why, and a Retry, and it is still not trusted', () => {
        const html = body(step(), { kind: 'failed', reason: 'the record could not be saved' });
        expect(html).toContain('the record could not be saved');
        expect(html).toMatch(/data-action="trust-workspace-retry"/);
        expect(html).toMatch(/role="alert"/);
    });
});

describe('it is where a person sees it (reads the source: no window is opened here)', () => {
    const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

    it('the workspace surface draws it, from what the shell hands it', () => {
        expect(read('renderer/components/Workspace.tsx')).toMatch(/<TrustStep\b/);
        expect(read('renderer/Shell.tsx')).toMatch(/trustStep=/);
    });

    it('a moved verdict is pushed to the windows', () => {
        expect(read('main/main.ts')).toMatch(/onTrustVerdict: \(workspaceId\) => \{[^}]*requestFeaturePush/);
    });
});
