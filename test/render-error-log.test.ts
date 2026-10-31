import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RENDER_ERROR_PREFIX, forwardRendererConsole, renderErrorDetails, renderErrorLine } from '../src/core/render-error.js';

/**
 * A RENDER ERROR REACHES GENIE'S LOG (parity audit 2026-10-30, top-15 #7).
 *
 * Genie 1's boundary logged to the renderer console only (`renderer/components/ErrorBoundary.tsx` componentDidCatch,
 * v0.7.0-beta.342) — which in the installed app reaches no file. Genie 2's renderer console reaches no file either; main
 * already forwards the composer-focus line it cares about (genie#1235). A render error is forwarded the same way, and
 * written to the one log Genie keeps on disk, `~/.genie/runtime/lifecycle.log`.
 */
describe('the renderer\'s render-error line', () => {
    const error = Object.assign(new Error('Cannot read properties of undefined (reading \'map\')'), { stack: 'Error: boom\n    at Dashboard (app.js:1:2)\n    at x (app.js:3:4)' });

    it('is one line: the prefix, the surface and the message — no newline, whatever the message holds', () => {
        const line = renderErrorLine('Dashboard', new Error('two\nlines'));
        expect(line.startsWith(RENDER_ERROR_PREFIX)).toBe(true);
        expect(line).toMatch(/surface=Dashboard/);
        expect(line).toMatch(/two lines/);
        expect(line).not.toMatch(/\n/);
    });

    it('a thrown non-Error still says what was thrown', () => {
        expect(renderErrorLine('Chat', 'a string')).toMatch(/a string/);
        expect(renderErrorLine('Chat', undefined)).toMatch(/undefined/);
    });

    it('the copied details carry the surface, the message, the stack and the component stack', () => {
        const text = renderErrorDetails({ surface: 'Dashboard', error, componentStack: '\n    at Dashboard\n    at Shell', version: '2.0.0-beta.52' });
        expect(text).toMatch(/Dashboard/);
        expect(text).toMatch(/reading 'map'/);
        expect(text).toMatch(/at Dashboard \(app\.js:1:2\)/);
        expect(text).toMatch(/at Shell/);
        expect(text).toMatch(/2\.0\.0-beta\.52/);
    });
});

describe('main forwarding the renderer console', () => {
    const sinks = () => {
        const out: string[] = [];
        const err: string[] = [];
        const file: string[] = [];
        return { out, err, file, ports: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), log: (l: string) => file.push(l) } };
    };

    it('a render error goes to main\'s error output AND the lifecycle log', () => {
        const s = sinks();
        forwardRendererConsole(renderErrorLine('Dashboard', new Error('Dashboard exploded')), s.ports);
        expect(s.err).toHaveLength(1);
        expect(s.file).toHaveLength(1);
        expect(s.file[0]).toMatch(/^render-error surface=Dashboard/);
        expect(s.file[0]).toMatch(/Dashboard exploded/);
    });

    it('the composer-focus line keeps its old path (main\'s output, not the file)', () => {
        const s = sinks();
        forwardRendererConsole('[genie] focus: composer took the caret', s.ports);
        expect(s.out).toEqual(['[genie] focus: composer took the caret']);
        expect(s.file).toEqual([]);
    });

    it('anything else the renderer prints is not forwarded', () => {
        const s = sinks();
        forwardRendererConsole('Download the React DevTools for a better development experience', s.ports);
        expect([...s.out, ...s.err, ...s.file]).toEqual([]);
    });

    it('both windows with a renderer forward through it (Genie\'s window and the doctor\'s)', () => {
        for (const file of ['src/main/main.ts', 'src/main/doctor.ts']) {
            const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
            expect(src, file).toMatch(/console-message[^\n]*forwardRendererConsole/);
        }
    });

    it('the renderer root is wrapped: main.tsx renders <App/> inside the whole-window boundary', () => {
        const src = readFileSync(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');
        expect(src).toMatch(/<ErrorBoundary[^>]*\bwhole\b[^>]*>\s*<App\s*\/>\s*<\/ErrorBoundary>/);
    });
});
