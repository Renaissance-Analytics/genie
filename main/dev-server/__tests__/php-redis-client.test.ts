import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { phpLoadsRedis, phpModulesCommand, probePhpRedis } from '../php-redis-client';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe('loaded Redis detection', () => {
    it('recognizes a loaded module, including CRLF', () => {
        expect(phpLoadsRedis('[PHP Modules]\r\ncurl\r\nredis\r\n[Zend Modules]\r\n')).toBe(true);
    });
    it.each([
        '', 'redis', '[PHP Modules]\nrediscluster\n[Zend Modules]',
        'Warning: Unable to load redis\n[PHP Modules]\ncurl\n[Zend Modules]',
        '[PHP Modules]\ncurl\n[Zend Modules]\nredis',
    ])('does not mistake missing modules or warnings for success: %j', (output) => {
        expect(phpLoadsRedis(output)).toBe(false);
    });
    it.each([false, true])('executes only the resolved binary and checks process failure (error=%s)', async (failure) => {
        vi.mocked(execFile).mockImplementation(((_exe: unknown, _args: unknown, _opts: unknown, callback: Function) => {
            callback(failure ? new Error('probe failed') : null, '[PHP Modules]\nredis\n[Zend Modules]', '');
        }) as never);
        const env = { PHPRC: '/site/php.ini' };
        expect(await probePhpRedis({ command: ['/managed/php-cgi', '-m'], cwd: '/site', env })).toBe(!failure);
        expect(execFile).toHaveBeenCalledWith('/managed/php-cgi', ['-m'], {
            cwd: '/site', env, windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024,
        }, expect.any(Function));
    });
});

describe('direct PHP commands', () => {
    it('preserves ini settings and ignores application arguments', () => {
        expect(phpModulesCommand(['C:\\PHP\\php.exe', '-n', '-c', 'local.ini', '-dextension=redis', '-d', 'memory_limit=256M', 'artisan', 'serve']))
            .toEqual(['C:\\PHP\\php.exe', '-n', '-c', 'local.ini', '-dextension=redis', '-d', 'memory_limit=256M', '-m']);
        expect(phpModulesCommand(['/usr/bin/php8.4', 'artisan', 'serve'])).toEqual(['/usr/bin/php8.4', '-m']);
    });
    it.each([[], ['npm', 'run', 'dev'], ['not-php'], ['php', '-d']].map(command => ({ command })))('rejects unrelated or incomplete commands: %j', ({ command }) => {
        expect(phpModulesCommand(command)).toBeUndefined();
    });
});
