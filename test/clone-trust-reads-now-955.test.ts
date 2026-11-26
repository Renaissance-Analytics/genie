import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * WHAT A WORKSPACE'S FILES WOULD CREATE IS DECIDED BY A READ MADE THEN (Tynn #955). A flow or a process created from
 * `.flows/` or `.processes/` is the one thing Genie makes runnable from a workspace's own file. The host answered "is
 * it trusted?" for that from the verdict it last kept, which can be older than the file being applied: that file is
 * itself what would make the workspace untrusted. genie-host's wiring is not composed in a unit test, so this reads it.
 */
const source = readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
/** The source without its comments, a line at a time: a rule stated in a comment is not the rule kept. */
const code = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

describe('genie-host: the trust a clone\u2019s flows and processes are created by', () => {
    it('the control: the restore and the clone watch are wired here, each with a `trusted` port', () => {
        expect(code).toContain('cloneOffersService.attach(');
        expect(code.match(/\btrusted: /g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    });

    it('no `trusted` port answers from the kept verdict', () => {
        const kept = code.split('\n').filter((line) => /\btrusted: \(id\)/.test(line) && /\.trust\.view\(/.test(line));
        expect(kept, 'a `trusted` port reading trust.view (the verdict as last kept)').toEqual([]);
    });

    it('the restore\u2019s port reads the workspace then: trust.refresh, awaited, and a read that fails is a no', () => {
        const ports = code.split('\n').filter((line) => /\btrusted: /.test(line) && /\.trust\.refresh\(/.test(line));
        expect(ports.length, 'a `trusted` port made of trust.refresh').toBeGreaterThanOrEqual(1);
        for (const line of ports) expect(line).toMatch(/\.catch\(\(\) => null\)/);
    });
});
