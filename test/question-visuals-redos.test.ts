import { describe, expect, it } from 'vitest';
import { sanitizeMockupHtml } from '../src/core/question-visuals.js';

/**
 * CodeQL js/redos (genie alert #130, src/core/question-visuals.ts): the leading-doctype pattern
 * `^(?:\s|<!--[\s\S]*?-->)*<!doctype…` backtracks polynomially on a page an agent posts that holds many unclosed
 * `<!--` and no doctype. The doctype is found by a linear scan instead, with the same answer.
 */
describe('sanitizeMockupHtml: the leading doctype is found in linear time', () => {
    it('a page of many unclosed comment openers is answered quickly', () => {
        const page = '<!--'.repeat(20_000) + ' '.repeat(20_000) + 'x';
        const started = performance.now();
        sanitizeMockupHtml(page);
        expect(performance.now() - started).toBeLessThan(1_000);
    });

    it('a doctype after whitespace and comments still goes first, before the policy head', () => {
        const out = sanitizeMockupHtml('  <!-- a -->\n<!-- b --><!DOCTYPE html><p>hi</p>');
        expect(out.startsWith('  <!-- a -->\n<!-- b --><!DOCTYPE html><head>')).toBe(true);
        expect(out).toContain('<p>hi</p>');
    });

    it('a doctype that is not first (after text) is not moved: the policy head goes first', () => {
        const out = sanitizeMockupHtml('text<!DOCTYPE html><p>hi</p>');
        expect(out.startsWith('<head>')).toBe(true);
    });

    it('control: a page without a doctype gets the policy head first', () => {
        expect(sanitizeMockupHtml('<p>hi</p>').startsWith('<head>')).toBe(true);
    });
});
