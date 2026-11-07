import { describe, expect, it } from 'vitest';
import { opcacheIsBuiltIn, phpIniContents } from '../src/core/php-versions.js';

/**
 * PHP 8.5 HAS OPCACHE BUILT IN (genie#1394). Installing 8.5.12 through Genie on Windows failed: the php.ini Genie writes
 * loaded opcache as a `zend_extension`, 8.5 has no opcache to load (it is compiled into every build since 8.5), and
 * php-cgi printed "Failed loading Zend extension 'opcache'" — so the install's own php-cgi check refused the version.
 * The ini is version-aware: below 8.5 it loads the extension, from 8.5 it only configures it. The `opcache.*` settings
 * (genie#1043: Laravel recompiled on every request without them) stay in both.
 */

const win85 = phpIniContents('C:\\genie\\toolchain\\php-versions\\8.5.12');
const win84 = phpIniContents('C:\\genie\\toolchain\\php-versions\\8.4.27');
const linux85 = phpIniContents('/home/g/.genie/toolchain/php-versions/8.5.12', 'linux');
const linux84 = phpIniContents('/home/g/.genie/toolchain/php-versions/8.4.27', 'linux');

describe('opcache in the managed php.ini, by version', () => {
    it('8.5 on Windows: no zend_extension=opcache (there is nothing to load), opcache still on with its file cache', () => {
        expect(win85).not.toMatch(/^zend_extension\s*=\s*opcache/m);
        expect(win85).toMatch(/^opcache\.enable=1$/m);
        expect(win85).toContain('opcache.file_cache="C:\\genie\\toolchain\\php-versions\\8.5.12\\opcache"');
        expect(win85).toMatch(/^opcache\.validate_timestamps=1$/m);
    });

    it('8.5 built from source on Linux: the same', () => {
        expect(linux85).not.toMatch(/^zend_extension\s*=\s*opcache/m);
        expect(linux85).toMatch(/^opcache\.enable=1$/m);
    });

    it('CONTROL: 8.4 still loads opcache as an extension, on both', () => {
        expect(win84).toMatch(/^zend_extension=opcache$/m);
        expect(linux84).toMatch(/^zend_extension=opcache$/m);
        expect(win84).toMatch(/^opcache\.enable=1$/m);
    });

    it('which versions have it built in: 8.5 and later, never 8.4 or before', () => {
        expect(['8.5.0', '8.5.12', '8.6.1', '9.0.0', '10.1.2'].map(opcacheIsBuiltIn)).toEqual([true, true, true, true, true]);
        expect(['8.4.27', '8.3.35', '8.2.34', '7.4.33'].map(opcacheIsBuiltIn)).toEqual([false, false, false, false]);
    });
});
