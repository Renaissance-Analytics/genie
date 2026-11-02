import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A BREAK-PROBE MUST NAME A TEST THAT EXISTS (batch S: `host-reads-only-the-signed-in-account` expected a title found nowhere). The
 * expected text is a grep on the log, not a vitest filter, so a renamed test turns "red on the right test" into noise, and the VM is an
 * expensive place to learn it. Each helper also refuses at run time; this finds it on every PR, with no VM.
 */
const SCRIPTS = ['scripts/perf-lag/host-split-probes.sh', 'scripts/perf-lag/pty-fds-probes.sh'];
const read = (file: string): string => readFileSync(file, 'utf8').split('\r\n').join('\n');
/** One bash word from `at`: quoted (double, with bash's backslash escapes) or bare. Anchors span lines, so this reads the text and not its lines. */
function word(text: string, at: number): { value: string; end: number } {
    let i = at;
    while (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || (text[i] === '\\' && text[i + 1] === '\n')) i += text[i] === '\\' ? 2 : 1;
    if (text[i] !== '"') {
        let end = i;
        while (end < text.length && !/\s/.test(text[end]!)) end += 1;
        return { value: text.slice(i, end), end };
    }
    let value = '';
    for (i += 1; text[i] !== '"'; i += 1) {
        if (i >= text.length) throw new Error('an unterminated string in a probe');
        // In double quotes bash takes a backslash only before these; anywhere else it is itself.
        if (text[i] === '\\' && '"\\$`\n'.includes(text[i + 1] ?? '')) i += 1;
        value += text[i];
    }
    return { value, end: i + 1 };
}
/** Each call's six arguments, as bash would hand them over. */
function calls(text: string) {
    return [...text.matchAll(/^probe /gm)].map((match) => {
        let at = match.index + 'probe '.length;
        const args: string[] = [];
        for (let n = 0; n < 6; n += 1) { const next = word(text, at); args.push(next.value); at = next.end; }
        const [name, file, anchor, replacement, tests, expected] = args as [string, string, string, string, string, string];
        return { name, file, anchor, replacement, tests: tests.trim().split(/\s+/), expected };
    });
}

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

    it('EVERY PROBE’S ANCHOR IS IN ITS SOURCE FILE: one that is not breaks nothing, and proves nothing (batch T, two of them)', () => {
        // As the helper reads the file, CRLF folded; and the script's own anchors folded too, so a CRLF checkout cannot pass or fail this alone.
        const bad = calls(text).filter(({ file, anchor }) => !existsSync(file) || !read(file).includes(anchor.split('\r\n').join('\n')));
        expect(bad.map(({ name, file }) => `${name}: ${file}`)).toEqual([]);
    });

    it('every probe changes something: an anchor and a replacement that are the same is no probe', () => {
        expect(calls(text).filter(({ anchor, replacement }) => anchor === replacement).map(({ name }) => name)).toEqual([]);
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
    expect(one).toEqual({ name: 'x', file: 'src/a.ts', anchor: 'a', replacement: 'b', tests: [file], expected: `no test ${'is called this'}` });
    expect(read(one!.tests[0]!).includes(one!.expected)).toBe(false);
    // And an anchor, as the helper would fail on it: quotes and escapes come through as bash gives them, and a line break stays one.
    const [two] = calls('probe "y" test/probe-scripts.test.ts \\\n    "say \\"it\\" \\$ a\nb" "" \\\n    test/x.test.ts "z"\n');
    expect(two).toMatchObject({ name: 'y', anchor: 'say "it" $ a\nb', replacement: '', tests: ['test/x.test.ts'], expected: 'z' });
    expect(read('test/probe-scripts.test.ts').includes(`not ${'in this file at all'}`)).toBe(false);
});
