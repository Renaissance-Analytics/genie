import { describe, expect, it } from 'vitest';
import {
    attachmentChipLabel,
    attachmentKind,
    composerAttachmentSummary,
    formatAttachmentSize,
    suggestedSaveName,
} from '../agentinbox-attachments';

/**
 * The AgentInbox attachment CHIP's presentation decisions, pulled out of the
 * flyout so they are testable in the node-only suite (the renderer has no DOM
 * harness — see vitest.config.ts). The component then only wires these to Fancy
 * markup, which keeps the part that can be wrong under test.
 */

describe('formatAttachmentSize', () => {
    it('reads bytes as bytes and scales up at each 1024 boundary', () => {
        expect(formatAttachmentSize(0)).toBe('0 B');
        expect(formatAttachmentSize(512)).toBe('512 B');
        expect(formatAttachmentSize(1024)).toBe('1 KB');
        expect(formatAttachmentSize(1536)).toBe('1.5 KB');
        expect(formatAttachmentSize(1024 * 1024)).toBe('1 MB');
        expect(formatAttachmentSize(3.4 * 1024 * 1024)).toBe('3.4 MB');
    });

    it('never renders a fractional byte count or a negative size', () => {
        expect(formatAttachmentSize(1023)).toBe('1023 B');
        expect(formatAttachmentSize(-5)).toBe('0 B');
    });
});

describe('attachmentKind', () => {
    it('classifies by extension so the chip can pick an icon', () => {
        expect(attachmentKind('shot.png')).toBe('image');
        expect(attachmentKind('photo.JPEG')).toBe('image');
        expect(attachmentKind('spec.pdf')).toBe('doc');
        expect(attachmentKind('notes.md')).toBe('doc');
        expect(attachmentKind('app.ts')).toBe('code');
        expect(attachmentKind('bundle.zip')).toBe('archive');
        expect(attachmentKind('mystery.bin')).toBe('file');
        expect(attachmentKind('')).toBe('file');
    });
});

describe('attachmentChipLabel', () => {
    it('pairs the filename with a human size', () => {
        expect(attachmentChipLabel({ filename: 'spec.pdf', bytes: 2048 })).toBe('spec.pdf · 2 KB');
    });

    it('middle-truncates a very long name so the chip cannot blow up the row', () => {
        const label = attachmentChipLabel({
            filename: 'an-extremely-long-attachment-filename-that-would-wrap.pdf',
            bytes: 10,
        });
        expect(label.length).toBeLessThan('an-extremely-long-attachment-filename-that-would-wrap.pdf'.length);
        expect(label).toContain('…');
        // The extension survives — it is what tells the human what the file IS.
        expect(label).toContain('.pdf');
    });
});

describe('suggestedSaveName', () => {
    it('keeps a clean filename as-is', () => {
        expect(suggestedSaveName('report.pdf')).toBe('report.pdf');
    });

    it('strips any path the sender put in the name — a chip must not steer a write', () => {
        expect(suggestedSaveName('../../etc/passwd')).toBe('passwd');
        expect(suggestedSaveName('C:\\Windows\\System32\\evil.dll')).toBe('evil.dll');
        expect(suggestedSaveName('nested/dir/file.txt')).toBe('file.txt');
    });

    it('falls back to a generic name when nothing usable is left', () => {
        expect(suggestedSaveName('')).toBe('attachment');
        expect(suggestedSaveName('../')).toBe('attachment');
    });
});

describe('composerAttachmentSummary', () => {
    it('says nothing when there is nothing attached', () => {
        expect(composerAttachmentSummary([])).toBe('');
    });

    it('counts the files and totals their size', () => {
        expect(
            composerAttachmentSummary([
                { filename: 'a.md', bytes: 1024 },
                { filename: 'b.md', bytes: 1024 },
            ]),
        ).toBe('2 files · 2 KB');
        expect(composerAttachmentSummary([{ filename: 'a.md', bytes: 10 }])).toBe('1 file · 10 B');
    });
});
