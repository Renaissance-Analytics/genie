import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A BREAK-PROBE MUST NAME A TEST THAT EXISTS (batch S: `host-reads-only-the-signed-in-account` expected a title found nowhere). The
 * expected text is a grep on the log, not a vitest filter, so a renamed test turns "red on the right test" into noise, and the VM is an
 * expensive place to learn it. Each helper also refuses at run time; this finds it on every PR, with no VM.
 */
const SCRIPTS = ['scripts/perf-lag/host-split-probes.sh', 'scripts/perf-lag/pty-fds-probes.sh'];
const read = (file: string): string => readFileSync(file, 'utf8').split('\r\n').join('\n');
/** Each call's last two arguments: the test list, then the expected text. */
const CALL = /^probe "([^"]+)"[\s\S]*?\n?\s*"?(test\/[^"\n]*?)"? "([^"\n]+)"\s*$/gm;
const calls = (text: string) => [...text.matchAll(CALL)].map(([, name, tests, expected]) => ({ name: name!, tests: tests!.trim().split(/\s+/), expected: expected! }));

describe.each(SCRIPTS)('%s', (script) => {
    const text = read(script);

    it('this reads every probe in it: a parser that skipped some would prove nothing', () => {
        const found = calls(text);
        expect(found.length).toBeGreaterThan(0);
        expect(found.length).toBe((text.match(/^probe "/gm) ?? []).length);
    });

    it('every probe’s test file exists and holds the text it expects', () => {
        const bad = calls(text).filter(({ tests, expected }) => !tests.some((file) => existsSync(file) && read(file).includes(expected)));
        expect(bad.map(({ name, expected }) => `${name}: ${expected}`)).toEqual([]);
    });

    it('the helper says "no such test" before it breaks anything', () => {
        const helper = text.slice(text.indexOf('probe() {'), text.indexOf('\n}\n', text.indexOf('probe() {')));
        expect(helper).toMatch(/NO SUCH TEST/);
        expect(helper.indexOf('NO SUCH TEST')).toBeLessThan(helper.indexOf('cp "$file"'));
    });
});

it('CONTROL: the check catches a name found nowhere', () => {
    const file = 'test/probe-scripts.test.ts';
    expect(read(file).includes(`no test ${'is called this'}`)).toBe(false);
    const [one] = calls(`probe "x" src/a.ts \\\n    "a" "b" \\\n    ${file} "no test ${'is called this'}"\n`);
    expect(one).toEqual({ name: 'x', tests: [file], expected: `no test ${'is called this'}` });
    expect(read(one!.tests[0]!).includes(one!.expected)).toBe(false);
});
