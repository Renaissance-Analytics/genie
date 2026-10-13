import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/core/stream-event.js';
import { ledgerRow, type TimedEvent } from '../src/core/stream-view.js';

/**
 * A TOOL ROW SAYS WHAT IT RAN. The owner's beta.20 Stream (2026-10-13): four rows reading only "Bash". Claude's
 * tool_call title IS the tool's name (prism-acp: `title: name`); what it ran arrives as `rawInput` when the block
 * ends. The board's row is `Bash  php artisan test --filter=Challenge`, so for a title that only repeats the name, the
 * main field is the name and the call's own argument — the command, path, pattern, URL or task — on one line.
 * Codex's title already is the command, and stays what is shown.
 */
const timed = (event: StreamEvent): TimedEvent => ({ id: 'e1', event, at: 1_760_000_000_000 });
const claude = (name: string, rawInput: unknown, toolKind: Extract<StreamEvent, { kind: 'tool' }>['toolKind'] = 'execute'): StreamEvent =>
    ({ kind: 'tool', toolCallId: 't1', name, title: name, status: 'completed', toolKind, rawInput });

describe('a Claude tool row', () => {
    it('shows each tool’s own argument after its name — counted over the tools Claude runs', () => {
        const cases: Array<[string, unknown, string]> = [
            ['Bash', { command: 'php artisan test --filter=Challenge', description: 'Run the tests' }, 'Bash  php artisan test --filter=Challenge'],
            ['PowerShell', { command: 'Get-ChildItem' }, 'PowerShell  Get-ChildItem'],
            ['Read', { file_path: 'src/core/session.ts' }, 'Read  src/core/session.ts'],
            ['Grep', { pattern: 'x-mcp-header', path: 'src' }, 'Grep  x-mcp-header'],
            ['Glob', { pattern: '**/*.ts' }, 'Glob  **/*.ts'],
            ['WebFetch', { url: 'https://example.com/docs', prompt: 'summarise' }, 'WebFetch  https://example.com/docs'],
            ['Task', { description: 'Audit the files', prompt: 'long…' }, 'Task  Audit the files'],
        ];
        const wrong = cases.filter(([name, input, want]) => ledgerRow(timed(claude(name, input))).main !== want).map(([n]) => n);
        expect(wrong).toEqual([]);
    });

    it('an edit row is the file it edited (the board’s edit row), not the word Edit', () => {
        expect(ledgerRow(timed(claude('Edit', { file_path: 'src/core/session.ts', old_string: 'a', new_string: 'b' }, 'edit'))).main).toBe('src/core/session.ts');
    });

    it('a multi-line command is one line', () => {
        expect(ledgerRow(timed(claude('Bash', { command: 'cd repo\nnpm test' }))).main).toBe('Bash  cd repo npm test');
    });

    it('no arguments yet, or none recognised, is the name alone — never a guess, never `{}`', () => {
        expect(ledgerRow(timed(claude('Bash', null))).main).toBe('Bash');
        expect(ledgerRow(timed(claude('Bash', undefined))).main).toBe('Bash');
        expect(ledgerRow(timed(claude('Mystery', { n: 3 }))).main).toBe('Mystery');
    });

    it('a title that is more than the name (Codex) is still what is shown', () => {
        const codex: StreamEvent = { kind: 'tool', toolCallId: 't2', name: 'shell', title: 'npm test', status: 'completed', toolKind: 'execute', rawInput: { command: ['bash', '-lc', 'npm test'] } };
        expect(ledgerRow(timed(codex)).main).toBe('shell  npm test');
    });
});
