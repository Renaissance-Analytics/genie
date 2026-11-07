#!/usr/bin/env bash
# Prepares omarchy-test for test/live/app-inbox-php.live.ts (genie#1376): Genie's pinned Caddy, a php-cgi, a real
# Laravel app with a .env, and — when they can be fetched — FrankenPHP and a Laravel app with Octane. Writes the paths
# to /tmp/genie-live.env. VM only (every run starts from the clean snapshot, so this installs each time).
set -uo pipefail
echo "== tools"
for b in php php-cgi composer; do printf '%s: ' "$b"; command -v "$b" || echo none; done
php -v | head -1
php -r 'echo "php ini: ", php_ini_loaded_file() ?: "(none)", "  variables_order=", ini_get("variables_order"), "\n";'

npx tsx scripts/fetch-caddy.ts || { echo "SETUP: Caddy could not be fetched"; exit 1; }

if ! command -v php-cgi >/dev/null; then
    echo "== php-cgi: not with this PHP; Arch's package"
    sudo pacman -S --noconfirm --needed php-cgi >/dev/null 2>&1 || echo "SETUP: php-cgi could not be installed"
fi
printf 'php-cgi: '; command -v php-cgi && php-cgi -v | head -1

if ! command -v composer >/dev/null; then
    mkdir -p "$HOME/.local/bin"
    php -r "copy('https://getcomposer.org/download/latest-stable/composer.phar', '$HOME/.local/bin/composer');" && chmod +x "$HOME/.local/bin/composer"
    export PATH="$HOME/.local/bin:$PATH"
fi
composer --version 2>/dev/null | head -1

L=/tmp/genie-live-laravel
rm -rf "$L"
timeout 600 composer create-project laravel/laravel "$L" --no-interaction --prefer-dist --no-progress -q || { echo "SETUP: Laravel could not be created"; exit 1; }
test -f "$L/.env" || cp "$L/.env.example" "$L/.env"
(cd "$L" && php artisan --version)

F=/tmp/frankenphp
if timeout 300 curl -fsSL -o "$F" https://github.com/php/frankenphp/releases/latest/download/frankenphp-linux-x86_64; then chmod +x "$F"; "$F" version | head -1; else rm -f "$F"; echo "SETUP: FrankenPHP not fetched"; F=""; fi

O=""
if [ -n "$F" ]; then
    O=/tmp/genie-live-octane
    rm -rf "$O"; cp -r "$L" "$O"
    if (cd "$O" && timeout 400 composer require laravel/octane --no-interaction -q && cp "$F" ./frankenphp && timeout 200 php artisan octane:install --server=frankenphp --no-interaction); then
        echo "octane: installed"
    else
        echo "SETUP: Octane could not be installed"; O=""
    fi
fi
printf 'export PATH=%q\nexport GENIE_LIVE_LARAVEL=%q\nexport GENIE_LIVE_FRANKENPHP=%q\nexport GENIE_LIVE_OCTANE=%q\n' "$PATH" "$L" "$F" "$O" > /tmp/genie-live.env
echo "== setup done"
