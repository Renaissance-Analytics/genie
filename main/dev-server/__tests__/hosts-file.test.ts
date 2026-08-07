import { describe, expect, it, vi } from 'vitest';
import {
    HOSTS_BLOCK_BEGIN,
    HOSTS_BLOCK_END,
    renderGenHostsBlock,
    parseGenHostsBlock,
    upsertGenHostsBlock,
    hostsBlockNeedsUpdate,
    reconcileHostsFile,
} from '../hosts-file';

/**
 * The OS hosts-file manager for host-native `.gen` sites (Wish #102, story #238,
 * task #671). Hosts files cannot wildcard, so the sites manager writes one
 * concrete `127.0.0.1 <name>.gen` (+ `::1`) per site inside a delimited managed
 * block, so entries can be rewritten/removed cleanly and NEVER clobber the user's
 * own lines. The block math is pure ⇒ deterministically testable; the elevated
 * write is validated on a real machine.
 */
describe('hosts-file — managed .gen block', () => {
    it('renders a BEGIN/END-delimited block with 127.0.0.1 + ::1 for each name, sorted and deduped', () => {
        const block = renderGenHostsBlock(['moic.gen', 'app.gen', 'moic.gen']);
        expect(block.startsWith(HOSTS_BLOCK_BEGIN)).toBe(true);
        expect(block.trimEnd().endsWith(HOSTS_BLOCK_END)).toBe(true);
        // Sorted: app.gen before moic.gen.
        expect(block.indexOf('app.gen')).toBeGreaterThan(-1);
        expect(block.indexOf('app.gen')).toBeLessThan(block.indexOf('moic.gen'));
        // Both loopback families per name.
        expect(block).toContain('127.0.0.1\tapp.gen');
        expect(block).toContain('::1\tapp.gen');
        expect(block).toContain('127.0.0.1\tmoic.gen');
        expect(block).toContain('::1\tmoic.gen');
        // Deduped: moic.gen appears once per family.
        expect(block.match(/127\.0\.0\.1\tmoic\.gen/g)).toHaveLength(1);
    });

    it('parses the names back out of a rendered block (round-trip, sorted-unique)', () => {
        const content = `# a user header\n127.0.0.1 keep.test\n\n${renderGenHostsBlock(['b.gen', 'a.gen', 'a.gen'])}\n`;
        expect(parseGenHostsBlock(content)).toEqual(['a.gen', 'b.gen']);
    });

    it('parseGenHostsBlock returns [] when there is no managed block', () => {
        expect(parseGenHostsBlock('127.0.0.1 localhost\n255.255.255.255 broadcasthost\n')).toEqual([]);
    });

    it('appends the block to content that has none, preserving every original line first', () => {
        const original = '127.0.0.1\tlocalhost\n::1\tlocalhost\n';
        const out = upsertGenHostsBlock(original, ['moic.gen']);
        expect(out.startsWith(original)).toBe(true);
        expect(out).toContain(HOSTS_BLOCK_BEGIN);
        expect(out).toContain('127.0.0.1\tmoic.gen');
    });

    it('replaces an existing block IN PLACE, preserving lines before and after it', () => {
        const before = '# header\n127.0.0.1\tlocalhost\n';
        const after = '\n# trailing user note\n10.0.0.5\tnas.local\n';
        const start = `${before}${renderGenHostsBlock(['old.gen'])}\n${after}`;
        const out = upsertGenHostsBlock(start, ['new.gen']);
        expect(out).toContain('127.0.0.1\tlocalhost');
        expect(out).toContain('# trailing user note');
        expect(out).toContain('10.0.0.5\tnas.local');
        expect(out).toContain('new.gen');
        expect(out).not.toContain('old.gen');
        expect(out.match(new RegExp(HOSTS_BLOCK_BEGIN, 'g'))).toHaveLength(1);
    });

    it('removes the block entirely when given no names, keeping the surrounding content', () => {
        const start = `127.0.0.1\tlocalhost\n${renderGenHostsBlock(['x.gen'])}\n10.0.0.5\tnas.local\n`;
        const out = upsertGenHostsBlock(start, []);
        expect(out).not.toContain(HOSTS_BLOCK_BEGIN);
        expect(out).not.toContain('x.gen');
        expect(out).toContain('127.0.0.1\tlocalhost');
        expect(out).toContain('10.0.0.5\tnas.local');
    });

    it('is idempotent and order-independent — same set twice changes nothing', () => {
        const original = '127.0.0.1\tlocalhost\n';
        const once = upsertGenHostsBlock(original, ['a.gen', 'b.gen']);
        const twice = upsertGenHostsBlock(once, ['b.gen', 'a.gen']);
        expect(twice).toBe(once);
    });

    it('append-then-remove is exactly reversible — never touches the user\'s own entries', () => {
        const user = '127.0.0.1\tmyapp.test\n192.168.1.10\tprinter\n';
        const out = upsertGenHostsBlock(user, ['moic.gen']);
        expect(out).toContain('127.0.0.1\tmyapp.test');
        expect(out).toContain('192.168.1.10\tprinter');
        expect(upsertGenHostsBlock(out, [])).toBe(user);
    });

    it('preserves CRLF line endings when the file uses them', () => {
        const crlf = '127.0.0.1\tlocalhost\r\n';
        const out = upsertGenHostsBlock(crlf, ['moic.gen']);
        expect(out).toContain('\r\n');
        expect(out).not.toMatch(/[^\r]\n/);
    });

    it('hostsBlockNeedsUpdate is false in sync, true when the set differs', () => {
        const synced = upsertGenHostsBlock('127.0.0.1\tlocalhost\n', ['a.gen', 'b.gen']);
        expect(hostsBlockNeedsUpdate(synced, ['b.gen', 'a.gen'])).toBe(false);
        expect(hostsBlockNeedsUpdate(synced, ['a.gen'])).toBe(true);
        expect(hostsBlockNeedsUpdate(synced, ['a.gen', 'b.gen', 'c.gen'])).toBe(true);
    });

    it('self-heals a truncated block (BEGIN with no END) rather than corrupt the file', () => {
        const truncated = `127.0.0.1\tlocalhost\n${HOSTS_BLOCK_BEGIN}\n127.0.0.1\tstale.gen\n`;
        const out = upsertGenHostsBlock(truncated, ['fresh.gen']);
        expect(out.match(new RegExp(HOSTS_BLOCK_BEGIN, 'g'))).toHaveLength(1);
        expect(out).toContain('fresh.gen');
        expect(out).not.toContain('stale.gen');
        expect(out).toContain('127.0.0.1\tlocalhost');
    });

    it('REFUSES an injectable or non-.gen name rather than write a poisoned hosts file', () => {
        expect(() => renderGenHostsBlock(['evil.gen\n0.0.0.0 bank.com'])).toThrow();
        expect(() => renderGenHostsBlock(['has space.gen'])).toThrow();
        expect(() => renderGenHostsBlock(['notgen.test'])).toThrow();
        expect(() => renderGenHostsBlock([''])).toThrow();
        expect(() => upsertGenHostsBlock('127.0.0.1 localhost\n', ['bad name.gen'])).toThrow();
    });
});

describe('reconcileHostsFile — read/compute/write orchestration', () => {
    it('writes the upserted content once when the block would change', async () => {
        const read = vi.fn().mockResolvedValue('127.0.0.1\tlocalhost\n');
        const write = vi.fn().mockResolvedValue(undefined);
        const res = await reconcileHostsFile(['moic.gen'], { read, write });
        expect(res.changed).toBe(true);
        expect(write).toHaveBeenCalledOnce();
        expect(write.mock.calls[0][0]).toContain('127.0.0.1\tmoic.gen');
        expect(write.mock.calls[0][0]).toContain('127.0.0.1\tlocalhost');
    });

    it('does NOT write (no elevation prompt) when already in sync', async () => {
        const synced = upsertGenHostsBlock('127.0.0.1\tlocalhost\n', ['moic.gen']);
        const read = vi.fn().mockResolvedValue(synced);
        const write = vi.fn().mockResolvedValue(undefined);
        const res = await reconcileHostsFile(['moic.gen'], { read, write });
        expect(res.changed).toBe(false);
        expect(write).not.toHaveBeenCalled();
    });
});
