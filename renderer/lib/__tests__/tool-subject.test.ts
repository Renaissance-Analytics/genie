import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../main/agentsession/model';
import { toolSubject } from '../tool-subject';

/**
 * WHAT a tool call is acting on — the difference between "Write" and "Write · ipc.ts".
 *
 * The brief's phrasing for why this matters: *"it is editing `ipc.ts` right now"*. Until
 * genie#843 the model could not answer it — `ToolCall` was `{id, name, status}` and the
 * arguments were discarded on arrival. They are stored now, so this is the first consumer,
 * and it exists as a pure function rather than inline JSX because the interesting part is
 * the REFUSALS and those need asserting.
 *
 * The governing rule is §6.1 of the designer brief, applied to a string: when the subject
 * cannot be read, the answer is NOTHING — never "unknown", never the raw JSON. A tool line
 * that says `Write · unknown` claims Genie looked and found nothing; the truth is that this
 * provider shaped its arguments differently, which is not the reader's problem to narrate.
 */

const call = (rawInput: unknown, name = 'Write'): ToolCall => ({
    id: 't1',
    name,
    status: 'pending',
    kind: null,
    rawInput,
    result: null,
    at: 1,
});

describe('toolSubject', () => {
    it('names the file for an edit', () => {
        expect(toolSubject(call({ file_path: 'C:\\w\\main\\acp\\ipc.ts', content: 'x' }))).toBe('ipc.ts');
    });

    it('takes the BASENAME, because the full path is noise in a one-line row', () => {
        // Measured from a real frame: the path was
        // `C:\Users\glenn\AppData\Local\Temp\genie-acp-work-JIwaCK\hello.txt`. A row showing
        // that says almost nothing about the edit and pushes the status off the line.
        expect(
            toolSubject(call({ file_path: 'C:\\Users\\me\\AppData\\Local\\Temp\\x\\hello.txt' })),
        ).toBe('hello.txt');
        expect(toolSubject(call({ file_path: '/home/me/src/main/db.ts' }))).toBe('db.ts');
    });

    it('names the command for a shell call', () => {
        expect(toolSubject(call({ command: 'npm test' }, 'Bash'))).toBe('npm test');
    });

    it('trims a long command rather than letting it take the row', () => {
        const long = `git log --format=${'x'.repeat(200)}`;
        const got = toolSubject(call({ command: long }, 'Bash'))!;
        expect(got.length).toBeLessThanOrEqual(61);
        expect(got.endsWith('…')).toBe(true);
    });

    it('reads the other shapes providers actually use', () => {
        expect(toolSubject(call({ path: '/a/b/c.md' }, 'Read'))).toBe('c.md');
        expect(toolSubject(call({ pattern: 'TODO' }, 'Grep'))).toBe('TODO');
        expect(toolSubject(call({ url: 'https://example.com/x' }, 'WebFetch'))).toBe(
            'https://example.com/x',
        );
    });

    it('returns NULL rather than guessing, and that is the point', () => {
        // Each of these is a real state, and none of them may render a word.
        expect(toolSubject(call(null))).toBeNull();
        expect(toolSubject(call(undefined))).toBeNull();
        expect(toolSubject(call({}))).toBeNull();
        // A shape we do not know. NOT stringified JSON into the row.
        expect(toolSubject(call({ somethingElse: 'x', nested: { deep: 1 } }))).toBeNull();
        // Non-objects off an untrusted wire.
        expect(toolSubject(call('a string'))).toBeNull();
        expect(toolSubject(call(42))).toBeNull();
        expect(toolSubject(call([1, 2]))).toBeNull();
    });

    it('refuses a value of the right NAME but the wrong TYPE', () => {
        // `rawInput` is untrusted. A `file_path` that is a number would otherwise reach
        // `basename` and throw inside a render.
        expect(toolSubject(call({ file_path: 42 }))).toBeNull();
        expect(toolSubject(call({ command: null }, 'Bash'))).toBeNull();
        expect(toolSubject(call({ file_path: '' }))).toBeNull();
        // Whitespace is not a subject either.
        expect(toolSubject(call({ command: '   ' }, 'Bash'))).toBeNull();
    });

    it('prefers the file over the command when a call carries both', () => {
        // Order is a decision, not an accident: the file is the more specific fact, and a tool
        // that reports both is describing one operation on that file.
        expect(toolSubject(call({ file_path: '/x/a.ts', command: 'write' }))).toBe('a.ts');
    });
});
