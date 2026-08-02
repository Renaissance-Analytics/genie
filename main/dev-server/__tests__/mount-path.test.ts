import { describe, expect, it } from 'vitest';
import { toMountSource } from '../mount-path';

/**
 * The bind-mount source path is the one string in this module that is NOT the
 * same on every platform, and getting it wrong is silent: the container starts
 * fine and `/workspace` is simply empty.
 *
 * Pure, so it is tested directly for every (platform, runtime) pair Genie ships
 * to — including the ones this machine can never exercise.
 */

describe('toMountSource', () => {
    it('gives docker a drive path with forward slashes', () => {
        // Docker Desktop accepts either separator, but a backslash inside a
        // `--mount source=` value is an escape hazard in every log, error and
        // shell the user will paste it into. Normalise once, here.
        expect(toMountSource('C:\\Users\\glenn\\proj', { platform: 'win32', kind: 'docker' })).toBe(
            'C:/Users/glenn/proj',
        );
    });

    it('gives podman the machine mount point for the drive', () => {
        // `podman machine` is a Linux VM; the host drives are mounted under
        // /mnt/<drive>. A `C:/...` source resolves INSIDE the VM and silently
        // creates an empty directory there instead of mounting the workspace.
        expect(toMountSource('C:\\Users\\glenn\\proj', { platform: 'win32', kind: 'podman' })).toBe(
            '/mnt/c/Users/glenn/proj',
        );
        expect(toMountSource('D:/work/repo', { platform: 'win32', kind: 'podman' })).toBe(
            '/mnt/d/work/repo',
        );
    });

    it('leaves POSIX paths untouched on mac and linux', () => {
        expect(toMountSource('/home/g/proj', { platform: 'linux', kind: 'docker' })).toBe(
            '/home/g/proj',
        );
        expect(toMountSource('/Users/g/proj', { platform: 'darwin', kind: 'podman' })).toBe(
            '/Users/g/proj',
        );
    });

    it('drops a trailing separator', () => {
        expect(toMountSource('C:\\work\\repo\\', { platform: 'win32', kind: 'docker' })).toBe(
            'C:/work/repo',
        );
        expect(toMountSource('/home/g/proj/', { platform: 'linux', kind: 'docker' })).toBe(
            '/home/g/proj',
        );
    });

    it('keeps a bare drive root usable', () => {
        expect(toMountSource('C:\\', { platform: 'win32', kind: 'docker' })).toBe('C:/');
        expect(toMountSource('/', { platform: 'linux', kind: 'docker' })).toBe('/');
    });

    it('refuses a UNC path — neither runtime can bind-mount one', () => {
        expect(toMountSource('\\\\server\\share\\proj', { platform: 'win32', kind: 'docker' })).toBeNull();
        expect(toMountSource('//server/share/proj', { platform: 'win32', kind: 'podman' })).toBeNull();
    });

    it('refuses a relative path', () => {
        expect(toMountSource('repo', { platform: 'linux', kind: 'docker' })).toBeNull();
        expect(toMountSource('./repo', { platform: 'linux', kind: 'docker' })).toBeNull();
        expect(toMountSource('', { platform: 'linux', kind: 'docker' })).toBeNull();
    });

    it('refuses a path a `--mount` value cannot carry', () => {
        // `--mount` is comma/equals delimited, so those two characters in a
        // source path would be read as the start of another mount option. They
        // are legal in a Linux directory name, so this has to be checked rather
        // than assumed — the alternative (`-v src:dst`) breaks on the Windows
        // drive colon instead, which is far more common.
        expect(toMountSource('/home/g/a,b', { platform: 'linux', kind: 'docker' })).toBeNull();
        expect(toMountSource('/home/g/a=b', { platform: 'linux', kind: 'docker' })).toBeNull();
    });
});
