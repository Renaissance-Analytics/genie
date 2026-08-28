import { describe, expect, it } from 'vitest';
import { resolveActiveBoardPost } from '../artboard-model';

describe('ArtBoard active preview', () => {
    const posts = [
        { id: 'new', title: 'New', kind: 'html', createdAt: 'now' },
        { id: 'old', title: 'Old', kind: 'image', createdAt: 'then' },
    ] as const;

    it('selects the artifact requested by artboard.post', () => {
        expect(resolveActiveBoardPost(posts as never, 'old')?.id).toBe('old');
    });

    it('falls back to the newest artifact when the requested one is gone', () => {
        expect(resolveActiveBoardPost(posts as never, 'missing')?.id).toBe('new');
    });
});
