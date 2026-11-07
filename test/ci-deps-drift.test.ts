import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * THE FANCY + PRISM DRIFT WATCHER (scripts/ci/deps-drift.mjs, .github/workflows/deps-drift.yml; Tynn #442).
 * The owner, 10-15: "make sure we have a drift watcher step in our ci for the fancy and prism deps"; 10-22: "make sure we
 * having something in our drift watcher that catches these security issues right away".
 * Drift WARNS (a table in the job summary, the job stays green). A known advisory on a pinned @particle-academy/* package,
 * or on anything under one, FAILS.
 */
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

type Fixture = { latest: Record<string, string>; audit?: unknown; ghsa?: unknown };

const pkg = {
    dependencies: {
        '@particle-academy/fancy-flow': '^0.81.0',
        '@particle-academy/prism-acp': '0.37.0',
        '@particle-academy/react-fancy': '6.7.2',
        'left-pad': '1.3.0',
    },
};
const lock = {
    lockfileVersion: 3,
    packages: {
        '': { dependencies: pkg.dependencies },
        'node_modules/@particle-academy/fancy-flow': { version: '0.81.0' },
        'node_modules/@particle-academy/prism-acp': { version: '0.37.0' },
        'node_modules/@particle-academy/react-fancy': { version: '6.7.2' },
        'node_modules/@particle-academy/react-fancy/node_modules/@particle-academy/fancy-file-commons': { version: '0.5.0' },
        'node_modules/left-pad': { version: '1.3.0' },
        'node_modules/minimist': { version: '1.2.5' },
    },
};
const upToDate = {
    '@particle-academy/fancy-flow': '0.81.0',
    '@particle-academy/prism-acp': '0.37.0',
    '@particle-academy/react-fancy': '6.7.2',
    '@particle-academy/fancy-file-commons': '0.5.0',
};

function run(f: Fixture) {
    dir = mkdtempSync(join(tmpdir(), 'deps-drift-'));
    const file = (name: string, v: unknown) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(v)); return p; };
    const summary = join(dir, 'summary.md');
    const args = ['scripts/ci/deps-drift.mjs', 'report',
        '--package', file('package.json', pkg),
        '--lock', file('package-lock.json', lock),
        '--latest', file('latest.json', f.latest),
        '--audit', file('audit.json', f.audit ?? { vulnerabilities: {} }),
        '--summary', summary];
    if (f.ghsa !== undefined) args.push('--ghsa', file('ghsa.json', f.ghsa));
    const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
    let md = '';
    try { md = readFileSync(summary, 'utf8'); } catch { md = ''; }
    return { code: r.status, out: `${r.stdout}${r.stderr}`, md };
}

describe('the fancy + prism drift watcher', () => {
    it('lists every pinned @particle-academy package, direct and nested, and nothing else', () => {
        const { code, md } = run({ latest: upToDate });
        expect(code).toBe(0);
        for (const name of ['fancy-flow', 'prism-acp', 'react-fancy', 'fancy-file-commons']) expect(md).toContain(`@particle-academy/${name}`);
        expect(md).not.toContain('left-pad');
        expect(md).not.toContain('minimist');
        expect(md).toMatch(/\|\s*@particle-academy\/prism-acp\s*\|\s*0\.37\.0\s*\|\s*0\.37\.0\s*\|\s*up to date\s*\|/);
    });

    it('drift alone WARNS: the table says how far behind, and the job stays green', () => {
        const { code, out, md } = run({ latest: { ...upToDate, '@particle-academy/fancy-flow': '0.84.2', '@particle-academy/react-fancy': '7.0.0', '@particle-academy/prism-acp': '0.37.3' } });
        expect(code).toBe(0);
        expect(md).toMatch(/\|\s*@particle-academy\/fancy-flow\s*\|\s*0\.81\.0\s*\|\s*0\.84\.2\s*\|\s*3 minor\s*\|/);
        expect(md).toMatch(/\|\s*@particle-academy\/react-fancy\s*\|\s*6\.7\.2\s*\|\s*7\.0\.0\s*\|\s*1 major\s*\|/);
        expect(md).toMatch(/\|\s*@particle-academy\/prism-acp\s*\|\s*0\.37\.0\s*\|\s*0\.37\.3\s*\|\s*3 patch\s*\|/);
        expect(out).toMatch(/::warning[^\n]*3 of 4 @particle-academy packages behind/);
        expect(out).not.toContain('::error');
    });

    it('an advisory on a pinned @particle-academy package FAILS the job and names it', () => {
        const audit = { vulnerabilities: { '@particle-academy/prism-acp': {
            name: '@particle-academy/prism-acp', severity: 'high', isDirect: true, range: '<0.37.1',
            nodes: ['node_modules/@particle-academy/prism-acp'],
            via: [{ source: 1101, name: '@particle-academy/prism-acp', title: 'Something unsafe', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', range: '<0.37.1' }],
            effects: [],
        } } };
        const { code, out, md } = run({ latest: upToDate, audit });
        expect(code).toBe(1);
        expect(out).toMatch(/::error[^\n]*@particle-academy\/prism-acp@0\.37\.0[^\n]*GHSA-aaaa-bbbb-cccc/);
        expect(md).toContain('GHSA-aaaa-bbbb-cccc');
        expect(md).toContain('Something unsafe');
    });

    it('an advisory on a TRANSITIVE dependency of a @particle-academy package fails, named through the package it reaches', () => {
        const audit = { vulnerabilities: {
            minimist: { name: 'minimist', severity: 'critical', isDirect: false, range: '<1.2.6', nodes: ['node_modules/minimist'],
                via: [{ source: 2202, name: 'minimist', title: 'Prototype pollution', url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h', severity: 'critical', range: '<1.2.6' }],
                effects: ['@particle-academy/fancy-flow'] },
            '@particle-academy/fancy-flow': { name: '@particle-academy/fancy-flow', severity: 'critical', isDirect: true, range: '*',
                nodes: ['node_modules/@particle-academy/fancy-flow'], via: ['minimist'], effects: [] },
        } };
        const { code, out, md } = run({ latest: upToDate, audit });
        expect(code).toBe(1);
        expect(out).toMatch(/::error[^\n]*@particle-academy\/fancy-flow@0\.81\.0[^\n]*minimist[^\n]*GHSA-xvch-5gv4-984h/);
        expect(md).toContain('Prototype pollution');
    });

    it('an advisory OUTSIDE the @particle-academy tree does not fail this job (that is npm audit\'s own business)', () => {
        const audit = { vulnerabilities: { 'left-pad': { name: 'left-pad', severity: 'high', isDirect: true, range: '*', nodes: ['node_modules/left-pad'],
            via: [{ source: 3303, name: 'left-pad', title: 'Unrelated', url: 'https://github.com/advisories/GHSA-zzzz-zzzz-zzzz', severity: 'high', range: '*' }], effects: [] } } };
        const { code, out } = run({ latest: upToDate, audit });
        expect(code).toBe(0);
        expect(out).not.toContain('::error');
    });

    it('a GitHub advisory database hit on a pinned package fails too', () => {
        const ghsa = { '@particle-academy/react-fancy@6.7.2': [{ ghsa_id: 'GHSA-1111-2222-3333', summary: 'XSS in a thing', severity: 'medium', html_url: 'https://github.com/advisories/GHSA-1111-2222-3333' }] };
        const { code, out, md } = run({ latest: upToDate, ghsa });
        expect(code).toBe(1);
        expect(out).toMatch(/::error[^\n]*@particle-academy\/react-fancy@6\.7\.2[^\n]*GHSA-1111-2222-3333/);
        expect(md).toContain('XSS in a thing');
    });

    it('a backslash in an advisory, alone or before a pipe, renders as a literal cell and never breaks out of it', () => {
        const summary = String.raw`C:\tmp\x a\|b` + '\nsecond line';
        const ghsa = { '@particle-academy/react-fancy@6.7.2': [{ ghsa_id: 'GHSA-1111-2222-3333', summary, severity: 'medium', html_url: 'https://github.com/advisories/GHSA-1111-2222-3333' }] };
        const { code, md } = run({ latest: upToDate, ghsa });
        expect(code).toBe(1);
        // Backslashes first, then pipes, then newlines: each backslash doubles, the pipe is escaped on its own.
        expect(md).toContain(String.raw`C:\\tmp\\x a\\\|b second line`);
        // The row keeps its four columns: five pipes that are not escaped (an even run of backslashes before one is no escape).
        const row = md.split('\n').find((l) => l.includes('GHSA-1111-2222-3333')) ?? '';
        const unescaped = [...row.matchAll(/(\\*)\|/g)].filter((m) => (m[1] ?? '').length % 2 === 0).length;
        expect(unescaped).toBe(5);
    });

    it('a package npm could not answer for is reported as unknown, never as up to date', () => {
        const latest: Record<string, string> = { ...upToDate };
        delete latest['@particle-academy/prism-acp'];
        const { code, md } = run({ latest });
        expect(code).toBe(0);
        expect(md).toMatch(/\|\s*@particle-academy\/prism-acp\s*\|\s*0\.37\.0\s*\|\s*\?\s*\|\s*unknown\s*\|/);
    });
});

describe('the deps-drift workflow', () => {
    // Read inside each test: a missing workflow fails these two, not the whole file at collection.
    const workflow = () => readFileSync('.github/workflows/deps-drift.yml', 'utf8').replace(/\r\n/g, '\n');
    it('runs daily, on demand, and on PRs that touch the manifest or the lockfile', () => {
        const wf = workflow();
        expect(wf).toMatch(/schedule:\n\s+- cron: '[^']+'/);
        expect(wf).toMatch(/workflow_dispatch:/);
        expect(wf).toMatch(/pull_request:\n\s+paths:[\s\S]*?- package\.json[\s\S]*?- package-lock\.json/);
    });
    it('runs the audit against the lockfile and the report step decides red or green', () => {
        const wf = workflow();
        expect(wf).toMatch(/npm audit --package-lock-only --json/);
        expect(wf).toMatch(/node scripts\/ci\/deps-drift\.mjs collect/);
        expect(wf).toMatch(/node scripts\/ci\/deps-drift\.mjs report[^\n]*--summary "\$GITHUB_STEP_SUMMARY"/);
    });
});
