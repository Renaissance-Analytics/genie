# Supported Stacks

A **Stack** is a recognized combination of language, framework, and tooling that tynn-cli commands can detect and adapt to. Each stack defines detection criteria, supported tools, and default behaviors.

## Stack Detection

Commands detect the current stack by checking for specific files in the project root. Detection is performed in order; the first match wins.

---

## Laravel (PHP)

**ID:** `laravel`

**Detection:**
- `artisan` file exists AND
- `composer.json` exists

**Package Manager:** `composer`

**Supported Tools (`puse`):**
| Tool | Command | Description |
|------|---------|-------------|
| `pest` | `puse pest` | Install Pest 4 testing framework |
| `pest-browser` | `puse pest --browser` | Pest with Playwright browser testing |
| `flux` | `puse flux` | Install Flux UI components |

**Commands:**
| Command | Behavior |
|---------|----------|
| `resetme` | `php artisan migrate:fresh` |
| `resetme --seed` | `php artisan migrate:fresh --seed` |
| `resetme --demo` | `php artisan migrate:fresh --seed && php artisan db:seed --class=DemoSeeder` |

---

## Node.js + Prisma

**ID:** `node-prisma`

**Detection:**
- `package.json` exists AND
- `prisma` in dependencies/devDependencies OR `prisma/schema.prisma` exists

**Package Manager:** `npm` | `pnpm` | `yarn` | `bun` (auto-detected)

**Supported Tools (`puse`):**
| Tool | Command | Description |
|------|---------|-------------|
| `vitest` | `puse vitest` | Install Vitest testing framework |
| `jest` | `puse jest` | Install Jest testing framework |
| `playwright` | `puse playwright` | Install Playwright for E2E testing |

**Commands:**
| Command | Behavior |
|---------|----------|
| `resetme` | `npx prisma migrate reset --force` |
| `resetme --seed` | `npx prisma migrate reset --force` (runs seed if configured) |
| `resetme --demo` | `npx prisma migrate reset --force && npx prisma db seed -- --demo` |

---

## Node.js + Drizzle

**ID:** `node-drizzle`

**Detection:**
- `package.json` exists AND
- `drizzle-kit` in dependencies/devDependencies OR `drizzle/` directory exists

**Package Manager:** `npm` | `pnpm` | `yarn` | `bun` (auto-detected)

**Supported Tools (`puse`):**
| Tool | Command | Description |
|------|---------|-------------|
| `vitest` | `puse vitest` | Install Vitest testing framework |
| `jest` | `puse jest` | Install Jest testing framework |
| `playwright` | `puse playwright` | Install Playwright for E2E testing |

**Commands:**
| Command | Behavior |
|---------|----------|
| `resetme` | `npx drizzle-kit drop && npx drizzle-kit push` |
| `resetme --seed` | Reset + `npm run db:seed` |
| `resetme --demo` | Reset + `npm run db:seed:demo` |

---

## Node.js + Knex

**ID:** `node-knex`

**Detection:**
- `package.json` exists AND
- `knex` in dependencies/devDependencies OR `knexfile.js`/`knexfile.ts` exists

**Package Manager:** `npm` | `pnpm` | `yarn` | `bun` (auto-detected)

**Supported Tools (`puse`):**
| Tool | Command | Description |
|------|---------|-------------|
| `vitest` | `puse vitest` | Install Vitest testing framework |
| `jest` | `puse jest` | Install Jest testing framework |

**Commands:**
| Command | Behavior |
|---------|----------|
| `resetme` | `npx knex migrate:rollback --all && npx knex migrate:latest` |
| `resetme --seed` | Reset + `npx knex seed:run` |
| `resetme --demo` | Reset + seed + `npx knex seed:run --specific=demo` |

---

## Node.js + Sequelize

**ID:** `node-sequelize`

**Detection:**
- `package.json` exists AND
- `sequelize` in dependencies/devDependencies OR `.sequelizerc` exists

**Package Manager:** `npm` | `pnpm` | `yarn` | `bun` (auto-detected)

**Commands:**
| Command | Behavior |
|---------|----------|
| `resetme` | `npx sequelize-cli db:drop && db:create && db:migrate` |
| `resetme --seed` | Reset + `npx sequelize-cli db:seed:all` |

---

## Node.js + TypeORM

**ID:** `node-typeorm`

**Detection:**
- `package.json` exists AND
- `typeorm` in dependencies/devDependencies

**Package Manager:** `npm` | `pnpm` | `yarn` | `bun` (auto-detected)

**Commands:**
| Command | Behavior |
|---------|----------|
| `resetme` | `npx typeorm schema:drop && npx typeorm migration:run` |
| `resetme --seed` | Reset + `npm run db:seed` |

---

## Node.js (Generic)

**ID:** `node`

**Detection:**
- `package.json` exists AND
- No specific ORM detected

**Package Manager:** `npm` | `pnpm` | `yarn` | `bun` (auto-detected)

**Supported Tools (`puse`):**
| Tool | Command | Description |
|------|---------|-------------|
| `vitest` | `puse vitest` | Install Vitest testing framework |
| `jest` | `puse jest` | Install Jest testing framework |
| `prisma` | `puse prisma` | Install and initialize Prisma |
| `drizzle` | `puse drizzle` | Install and initialize Drizzle |

---

## Django (Python)

**ID:** `django`

**Detection:**
- `manage.py` exists AND
- `django` in requirements.txt/pyproject.toml OR `settings.py` in common locations

**Package Manager:** `pip` | `poetry` | `uv` (auto-detected)

**Supported Tools (`puse`):**
| Tool | Command | Description |
|------|---------|-------------|
| `pytest` | `puse pytest` | Install pytest-django |
| `playwright` | `puse playwright` | Install Playwright for E2E testing |

**Commands:**
| Command | Behavior |
|---------|----------|
| `resetme` | `python manage.py flush --no-input && python manage.py migrate` |
| `resetme --seed` | Reset + `python manage.py loaddata fixtures/*.json` |
| `resetme --demo` | Reset + `python manage.py loaddata fixtures/demo.json` |

---

## Flask + Alembic (Python)

**ID:** `flask-alembic`

**Detection:**
- `alembic.ini` exists OR `migrations/alembic.ini` exists

**Package Manager:** `pip` | `poetry` | `uv` (auto-detected)

**Commands:**
| Command | Behavior |
|---------|----------|
| `resetme` | `flask db downgrade base && flask db upgrade` (or alembic equivalents) |
| `resetme --seed` | Reset + `python seed.py` |

---

## Go + Migrate

**ID:** `go-migrate`

**Detection:**
- `go.mod` exists AND
- `migrations/` or `db/migrations/` directory exists

**Package Manager:** `go`

**Commands:**
| Command | Behavior |
|---------|----------|
| `resetme` | `migrate drop -f && migrate up` |
| `resetme --seed` | Reset + `go run cmd/seed/main.go` |

---

## Package Manager Detection (Node.js)

For Node.js stacks, the package manager is detected in this order:

1. `bun.lockb` exists → `bun`
2. `pnpm-lock.yaml` exists → `pnpm`
3. `yarn.lock` exists → `yarn`
4. Default → `npm`

---

## Package Manager Detection (Python)

For Python stacks, the package manager is detected in this order:

1. `uv.lock` exists → `uv`
2. `poetry.lock` exists → `poetry`
3. Default → `pip`

---

## Configuration

Users can configure stack behavior in `tynn.config`:

```bash
# Limit which stacks are allowed (empty = all allowed)
ALLOWED_STACKS=""

# Explicitly disallow certain stacks
DISALLOWED_STACKS=""

# Override detected stack (force a specific stack)
FORCE_STACK=""

# Tool restrictions per stack (comma-separated)
# Format: STACK_TOOLS_<STACK_ID>="tool1,tool2"
STACK_TOOLS_LARAVEL="pest,flux"
STACK_TOOLS_NODE="vitest,playwright"
```

---

## Adding New Stacks

To add support for a new stack:

1. Add detection logic to `lib/stacks.sh`
2. Document the stack in this file
3. Update relevant commands to handle the new stack
4. Add supported tools to `puse`
