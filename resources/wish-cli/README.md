# tynn-cli

A composable bash toolkit for developer workflows. Optimized for **Git Bash on Windows** (works on any bash shell).

## Commands

| Command | Description |
|---------|-------------|
| `puse` | Project Use - orchestrate tool installation per detected stack |
| `resetme` | Reset database/state for detected stack |
| `sandbox` | Run commands in configured sandbox directory |
| `pkg` | Run commands in monorepo `packages/` directories |
| `npmx` | Run npm commands in subdirectories |
| `copy-screenshots` | Copy Cursor browser extension screenshots to project |

## Quick Install

```bash
git clone <repo-url> ~/.local/share/tynn-cli && ~/.local/share/tynn-cli/install.sh
```

Or from an existing clone:

```bash
./install.sh
```

After installation, restart your terminal or run:
```bash
source ~/.bashrc
```

## Usage

### puse

Orchestrate project tool requirements based on detected stack.

```bash
puse <tool> [options]
puse --list              # List available tools for detected stack
puse --stack             # Show detected stack
```

**Options:**
- `--lic <name|index>` - Use license from tynn.config (for licensed tools)
- `--browser` - Enable browser testing support

**Examples:**
```bash
# Laravel
puse pest                # Install Pest testing framework
puse pest --browser      # Install Pest with Playwright browser testing
puse flux --lic myflux   # Install Flux Pro with license

# Node.js
puse vitest              # Install Vitest
puse jest                # Install Jest
puse playwright          # Install Playwright

# Python/Django
puse pytest              # Install pytest
```

### resetme

Reset database/state for the detected project stack.

```bash
resetme [options]
```

**Options:**
- `--seed` - Run default seeder after migrations
- `--demo` - Run default seeder + DemoSeeder (implies --seed)
- `--dry-run` - Show what would be executed without running
- `--stack` - Show detected stack and exit

**Examples:**
```bash
resetme                  # Reset database (migrate:fresh or equivalent)
resetme --seed           # Reset and seed
resetme --demo           # Reset, seed, and run DemoSeeder
resetme --dry-run        # Preview commands without executing
```

### sandbox

Run commands in your configured sandbox directory.

```bash
sandbox <command> [args...]
sandbox                  # Show sandbox path and stack
sandbox --path           # Print sandbox path only
sandbox --stack          # Show detected stack in sandbox
```

**Configuration:** Set `SANDBOX_PATH` in `tynn.config`

**Examples:**
```bash
sandbox resetme --demo
sandbox php artisan migrate
sandbox puse pest
```

### pkg

Run commands in monorepo `packages/` directories.

```bash
pkg <package> <command> [args...]
pkg <command> [args...]   # Auto-detect if only one package
```

**Examples:**
```bash
pkg php vendor/bin/pest                    # Auto-detect single package
pkg laravel-fun-lab php vendor/bin/pest    # Specify package
```

### npmx

Run npm commands in subdirectories containing `package.json`.

```bash
npmx <dir> <npm-command> [args...]
```

**Examples:**
```bash
npmx server test -- --run tests/services/chat.test.js
npmx client build
```

### copy-screenshots

Copy Cursor browser extension screenshots to project folders.

```bash
copy-screenshots <file1>:<folder1> [file2:folder2 ...]
```

**Defaults:**
- Source: `$LOCALAPPDATA/Temp/cursor-browser-extension`
- Target: `public/screenshots`

**Overrides:** `CURSOR_TEMP_BASE`, `SCREENSHOTS_DIR`

## Supported Stacks

Commands auto-detect your project stack and adapt behavior accordingly.

| Stack | Detection | Package Manager |
|-------|-----------|-----------------|
| Laravel | `artisan` + `composer.json` | composer |
| Node.js + Prisma | `package.json` + prisma | npm/pnpm/yarn/bun |
| Node.js + Drizzle | `package.json` + drizzle-kit | npm/pnpm/yarn/bun |
| Node.js + Knex | `package.json` + knex | npm/pnpm/yarn/bun |
| Node.js + Sequelize | `package.json` + sequelize | npm/pnpm/yarn/bun |
| Node.js + TypeORM | `package.json` + typeorm | npm/pnpm/yarn/bun |
| Django | `manage.py` + django | pip/poetry/uv |
| Flask + Alembic | `alembic.ini` | pip/poetry/uv |
| Go + Migrate | `go.mod` + migrations/ | go |

See [STACKS.md](STACKS.md) for detailed stack documentation.

## Runtime Resolution

Commands automatically find runtime executables on Windows/Git Bash:

**PHP:** Laravel Herd (`herd which-php`), Laragon, XAMPP, WAMP, scoop, Homebrew

**Python:** python3, python, py (Windows launcher)

**Go:** GOROOT, standard paths, scoop

## Configuration

Copy `tynn.config.example` to `tynn.config` and customize:

```bash
# Sandbox path for testing
SANDBOX_PATH="$HOME/sandbox/my-laravel-app"

# Stack restrictions (optional)
ALLOWED_STACKS="laravel,node-prisma"
DISALLOWED_STACKS=""

# Licensed tools (for puse --lic)
LICENSES='[
  {"name": "flux", "key": "your-license-key"}
]'
```

## Libraries

Shared utilities in `lib/`:

- `helpers.sh` - Output utilities: `log`, `warn`, `die`, `ok`, `info`, `need_cmd`, `need_file`
- `stacks.sh` - Stack detection, package manager utilities, runtime resolution
- `licenses.sh` - License management with JSON parsing

## Updating

```bash
cd ~/.local/share/tynn-cli
git pull
# Done - symlinked scripts update automatically
```

## Contributing

Add new commands as executable files in `bin/`.

**Script template:**
```bash
#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/../lib/helpers.sh"
source "$(dirname "${BASH_SOURCE[0]}")/../lib/stacks.sh"

# Your code here
```

**Conventions:**
- Shebang: `#!/usr/bin/env bash`
- Strict mode: `set -euo pipefail`
- Emoji prefixes: ✅ ❌ ⚠️ 📂 ⚡
- Use helpers: `log`, `warn`, `die`, `ok`, `need_cmd`
