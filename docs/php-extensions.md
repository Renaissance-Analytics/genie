# Managed PHP extensions

Genie installs Redis 6.3.0 alongside new managed Windows PHP versions. For an
existing install, use **Settings → Toolchain → Check and repair**. The result
names each verified installation and any failures. Restart running PHP sites
and workers after installing an extension so their processes load it.

The installer asks the actual PHP binary for its version, thread safety,
architecture, debug mode, compiler and extension API. It supports the managed
PHP 8.2/8.3 TS x64 VS16 and PHP 8.4 TS x64 VS17 builds. Unknown ABIs, NTS,
x86 and debug builds are refused; a similarly named DLL is not a substitute.
The source is the [official PHP PECL Windows archive](https://downloads.php.net/~windows/pecl/releases/redis/6.3.0/).
Each archive has a pinned SHA-256 checksum. Nothing is extracted until it matches.

The staged DLL must load in both CLI and CGI before activation. Genie then
enables it in that version's managed `php.ini` and checks both binaries again.
Failed activation restores the prior DLL and configuration; a failed new PHP
install restores the prior version directory. Existing compatible Redis
installs are verified without downloading again. Startup configuration refresh
preserves the extension. Other vendors' PHP installs are untouched.

This currently supplies Redis for the Windows PHP versions Genie can install.
It does not install arbitrary PECL packages or modify FrankenPHP's embedded
runtime. Adding another extension requires a reviewed artifact, ABI mapping,
checksums, any dependent libraries, and real CLI/CGI load tests.

## Why this set

The Tynn application audit used `composer.json`, production dependencies in
`composer.lock`, and targeted PHP source/configuration searches; no application
environment files were read. Tynn requires `predis/predis` and its database
configuration defaults to `phpredis`. Its production dependency requirements
include bcmath, ctype, curl, date, dom, fileinfo, filter, hash, iconv, json,
libxml, mbstring, openssl, pcre, session, SimpleXML, sodium, tokenizer, xml and
zlib. These are already built into or enabled by Genie's PHP 8.4.24 distribution.
Postgres support is also enabled (`pdo_pgsql` and `pgsql`).

No Imagick requirement or usage was found in Tynn's production Composer
requirements or application/configuration PHP source. Redis is the missing
native client. Imagick is therefore not added speculatively.

## Verification

Unit tests cover incompatible ABIs, checksum corruption, failed CLI/CGI loads,
rollback, idempotence, concurrent repair and honest failure reporting. The
Windows hosting CI lane also installs Redis through the production installer
into a fresh PHP 8.4.24 ZTS distribution and checks the real `Redis` class and
module loading in CLI and CGI. Its PHP-only test can run without starting a
server; the hosting and GUI suites remain CI-only.
