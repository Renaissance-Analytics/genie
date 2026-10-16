import { describe, expect, it } from 'vitest';
import { defaultSiteName, isGenHost, normalizeSiteName, siteNameProblem, slugLabel } from '../src/core/gen-name.js';

/**
 * S5 — A SITE'S `.gen` NAME, the one rule (hosting ship line). Genie 1 named a site `<site>.<workspace>.gen` by default
 * (repos/genie main/dev-server/sites-config.ts `defaultGenNameFor`), and Genie 2 refused every such name: one label only.
 * Now a name is one or more DNS labels, every label checked, and the default is Genie 1's. RFC 2606-style invented names.
 */

describe('siteNameProblem — every label checked', () => {
    it('CONTROL: one label is a name, as it always was', () => {
        expect(['tynn', 'my-site2', 'a', 'x'.repeat(63)].map(siteNameProblem)).toEqual([null, null, null, null]);
    });

    it('two and three labels are names (Genie 1’s default and a custom a.b.c)', () => {
        expect(['web.example', 'api.docs.example', 'Web.Example', 'web.example.gen'].map(siteNameProblem)).toEqual([null, null, null, null]);
    });

    it('counted refusals, each naming the label that is wrong', () => {
        const cases: Array<[string, RegExp]> = [
            ['', /needs a name/],
            ['web..example', /empty label/],
            ['.example', /empty label/],
            ['-web.example', /"-web" is not a hostname label/],
            ['web.example-', /"example-" is not a hostname label/],
            ['web_1.example', /"web_1" is not a hostname label/],
            [`web.${'a'.repeat(64)}`, /is not a hostname label/],
            [`${'a.'.repeat(125)}a`, /longer than the 253 characters/],
        ];
        const problems = cases.map(([name]) => siteNameProblem(name));
        expect(problems.filter((p) => p !== null)).toHaveLength(cases.length);
        cases.forEach(([, why], i) => expect(problems[i]).toMatch(why));
    });

    it('a typed .gen and a trailing dot are taken off once, never more', () => {
        expect(normalizeSiteName(' Web.Example.GEN ')).toBe('web.example');
        expect(normalizeSiteName('web.example.')).toBe('web.example');
        expect(normalizeSiteName('x.gen.gen')).toBe('x.gen');
    });
});

describe('isGenHost — what the front door serves, read strictly', () => {
    it('one or more valid labels then .gen; nothing else (counted)', () => {
        const yes = ['tynn.gen', 'web.example.gen', 'a.b.c.gen'];
        const no = ['gen', '.gen', 'tynn.gen.example.com', 'web..example.gen', 'web_1.example.gen', 'example.com', 'localhost'];
        expect(yes.filter(isGenHost)).toEqual(yes);
        expect(no.filter(isGenHost)).toEqual([]);
    });
});

describe('defaultSiteName — Genie 1’s <site>.<workspace>', () => {
    it('a folder in a workspace is <folder>.<workspace>, both reduced to a label', () => {
        expect(defaultSiteName({ folder: 'web', workspace: 'Example' })).toBe('web.example');
        expect(defaultSiteName({ folder: 'My App_v2', workspace: 'Example Co.' })).toBe('my-app-v2.example-co');
    });

    it('the workspace’s own folder is the workspace’s name alone (never example.example); no workspace name → the folder alone', () => {
        expect(defaultSiteName({ folder: null, workspace: 'Example' })).toBe('example');
        expect(defaultSiteName({ folder: 'web', workspace: null })).toBe('web');
        expect(defaultSiteName({ folder: 'web', workspace: '***' })).toBe('web');
        expect(defaultSiteName({ folder: '***', workspace: 'example' })).toBe('site.example');
    });

    it('every default is itself a valid name (the rule and the default agree)', () => {
        for (const n of [defaultSiteName({ folder: 'web', workspace: 'Example' }), defaultSiteName({ folder: null, workspace: 'x'.repeat(80) }), defaultSiteName({ folder: 'y'.repeat(80), workspace: 'z'.repeat(80) })]) {
            expect(siteNameProblem(n)).toBeNull();
        }
        expect(slugLabel('x'.repeat(80))).toHaveLength(63);
    });
});
