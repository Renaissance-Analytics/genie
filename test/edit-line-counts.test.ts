import { describe, expect, it } from 'vitest';
import { editLineCounts } from '../src/core/stream-view.js';

/**
 * LINE COUNTS FROM THE EDIT'S OWN ARGUMENTS. Claude's `Edit` sends one `old_string` / `new_string` pair at the top
 * level; `MultiEdit` sends `edits[]`. Both are real diffs and both must count. The dangling `else` that dropped the
 * plain pair hid behind tests that fed counts through the Stream's `diffs` map — found by the index column, which has
 * no such map.
 */
describe('editLineCounts', () => {
    it('a plain old/new pair at the top level counts — Claude’s Edit', () => {
        expect(editLineCounts({ file_path: 'a.ts', old_string: 'a', new_string: 'a\nb' })).toEqual({ plus: 1, minus: 0, newFile: false });
        expect(editLineCounts({ file_path: 'a.ts', old_string: 'a\nb', new_string: 'a\nc\nd' })).toEqual({ plus: 2, minus: 1, newFile: false });
    });

    it('an edits[] list sums its pairs — MultiEdit', () => {
        expect(editLineCounts({ file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'a\nb' }, { old_string: 'x', new_string: 'x\ny\nz' }] })).toEqual({ plus: 3, minus: 0, newFile: false });
    });

    it('nothing to diff → null, never a zero: a Write carries no before-and-after; null arguments report nothing', () => {
        expect(editLineCounts({ file_path: 'a.ts', content: 'hello' })).toBeNull();
        expect(editLineCounts(null)).toBeNull();
        expect(editLineCounts({ file_path: 'a.ts', edits: [] })).toBeNull();
    });

    it('a new file is every pair with an empty before', () => {
        expect(editLineCounts({ file_path: 'a.ts', old_string: '', new_string: 'one\ntwo' })).toEqual({ plus: 2, minus: 0, newFile: true });
    });
});
