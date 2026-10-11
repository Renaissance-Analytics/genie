import { describe, expect, it } from 'vitest';
import { flowFormDefaults, siteFormDefaults, validateFlowForm, validateSiteForm } from '../src/core/forms.js';

/**
 * THE FORMS BEHIND "Add a site" AND "Add a flow" — pure models: sensible defaults derived from what
 * is on disk (never guessed when nothing is), and validation that names every problem at once so
 * the person fixes the form in one pass. Guided, consistent, start to finish: a form that silently
 * does nothing is a bug.
 */

describe('Add a site', () => {
    it('defaults the name from the repo folder, the mode from the dev server detected, and the port to auto', () => {
        const d = siteFormDefaults({ repoPath: 'C:/_Projects/tynn.ai/repos/tynn', files: ['artisan', 'composer.json'], packageScripts: {} });
        expect(d).toEqual({ name: 'tynn', mode: 'proxy', devServer: { stack: 'laravel', command: 'php artisan serve --host=127.0.0.1 --port={port}' }, root: null, spa: false, hostPort: null, hint: 'Laravel detected — Genie will run `php artisan serve` on a free port.' });
    });

    it('a built directory with no dev server defaults to static SPA with that root', () => {
        const d = siteFormDefaults({ repoPath: '/w/dash', files: ['dist/index.html'], packageScripts: {} });
        expect(d).toMatchObject({ name: 'dash', mode: 'static', root: 'dist', spa: true });
        expect(d.hint).toMatch(/dist/);
    });

    it('nothing recognisable → proxy with NO dev server and a hint asking for a port or a command, never an invented command', () => {
        const d = siteFormDefaults({ repoPath: '/w/mystery', files: ['README.md'], packageScripts: {} });
        expect(d).toMatchObject({ mode: 'proxy', devServer: null, hostPort: null });
        expect(d.hint).toMatch(/port|command/i);
    });

    it('a folder name that is not a hostname label is lower-cased and sanitised for the default, and the original is kept in the hint', () => {
        const d = siteFormDefaults({ repoPath: '/w/My App_v2', files: [], packageScripts: {} });
        expect(d.name).toBe('my-app-v2');
    });

    it('validation names every problem at once', () => {
        expect(validateSiteForm({ name: '', mode: 'proxy', devServer: null, hostPort: null, root: null, spa: false }, [])).toEqual([
            { field: 'name', message: 'A site needs a name — one hostname label (a-z, 0-9, hyphens).' },
            { field: 'hostPort', message: 'A proxy site needs either a dev server command or a port you already run.' },
        ]);
        expect(validateSiteForm({ name: 'Bad Name', mode: 'static', devServer: null, hostPort: null, root: '', spa: true }, [])).toEqual([
            { field: 'name', message: '"Bad Name" is not a hostname label — use a-z, 0-9 and hyphens.' },
            { field: 'root', message: 'A static site needs the built directory to serve (for example dist).' },
        ]);
        expect(validateSiteForm({ name: 'docs', mode: 'proxy', devServer: null, hostPort: 5173, root: null, spa: false }, ['docs.gen'])).toEqual([
            { field: 'name', message: 'docs.gen is already a site.' },
        ]);
        expect(validateSiteForm({ name: 'docs', mode: 'proxy', devServer: null, hostPort: 70000, root: null, spa: false }, [])).toEqual([
            { field: 'hostPort', message: 'A port is a number from 1 to 65535.' },
        ]);
    });

    it('a valid form has no problems — the positive control', () => {
        expect(validateSiteForm({ name: 'tynn', mode: 'proxy', devServer: { stack: 'laravel', command: 'php artisan serve --port={port}' }, hostPort: null, root: null, spa: false }, [])).toEqual([]);
        expect(validateSiteForm({ name: 'app', mode: 'php', devServer: null, hostPort: null, root: 'public', spa: false }, [])).toEqual([]);
    });
});

describe('Add a flow', () => {
    it('defaults to a version-1 document with one schedule trigger (every hour, UTC) feeding one log node, named for the workspace', () => {
        const d = flowFormDefaults({ workspaceId: 'tynn' });
        expect(d.name).toBe('tynn hourly');
        expect(d.document).toMatchObject({ version: 1 });
        const doc = d.document as { nodes: Array<{ id: string; kind: string; config: Record<string, unknown> }>; edges: Array<{ source: string; target: string }> };
        expect(doc.nodes.map((n) => n.kind)).toEqual(['schedule_trigger', 'log']);
        expect(doc.nodes[0]!.config).toEqual({ cron: '0 * * * *', timezone: 'UTC' });
        expect(doc.edges).toEqual([{ id: 'e1', source: doc.nodes[0]!.id, target: doc.nodes[1]!.id }]);
        expect(d.armed).toBe(false);
    });

    it('validation: a name is required; a cron Genie cannot evaluate is named with the node; a non-UTC timezone is named', () => {
        const d = flowFormDefaults({ workspaceId: 'tynn' });
        expect(validateFlowForm({ ...d, name: '' })).toEqual([{ field: 'name', message: 'A flow needs a name.' }]);
        const bad = structuredClone(d.document) as { nodes: Array<{ config: Record<string, unknown> }> };
        bad.nodes[0]!.config = { cron: 'every day', timezone: 'Europe/Amsterdam' };
        expect(validateFlowForm({ ...d, document: bad })).toEqual([
            { field: 'cron', message: 'Node t: "every day" is not a cron expression Genie can evaluate (five fields: minute hour day month weekday).' },
            { field: 'timezone', message: 'Node t: timezone Europe/Amsterdam is not supported yet; schedules are evaluated in UTC.' },
        ]);
    });

    it('the default form validates clean — the positive control', () => {
        expect(validateFlowForm(flowFormDefaults({ workspaceId: 'tynn' }))).toEqual([]);
    });
});
