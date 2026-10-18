# Phase 1 — Session Notes & Recap

Everything covered in this session on Phase 1 so far, split into real hurdles we hit and fixed, and concepts covered along the way. See [phase_1_implementation_plan.md](./phase_1_implementation_plan.md) for the actual step-by-step plan these notes accompany.

## Hurdles encountered

### 1. `cookie-parser` wired up in the wrong scope — a real crash

`packages/server/src/main.ts` had `app.use(cookieParser())` at module top level, before `app` existed — it's declared with `const app` inside `bootstrap()`, a separate scope. This would throw `ReferenceError: app is not defined` on boot. Fixed by moving the line inside `bootstrap()`, after `NestFactory.create(AppModule)` and before `app.listen()`.

### 2. The big one: Prisma had silently drifted to an unreleased release candidate

Started from a simple question — "does `npx prisma format` work?" — and it didn't: `No command registered for 'format'`. Pulling on that thread unraveled a much bigger problem:

- `npx prisma --help` showed a completely different CLI than expected — a "Prisma Developer Platform" surface (`project`, `deploy`, `branch`, `service`, `postgres`, `bucket`, `git`...), not the familiar ORM commands.
- `prisma/migrations/` didn't exist at all — meaning the `prisma migrate dev --name init` from Phase 0 had never actually completed successfully, despite that checklist item being marked done.
- Chasing the renamed `format` command (`prisma contract format`) led to a *different* error: a missing `orm` config section with `adapter`/`family`/`target` fields — config our existing `prisma7.config.ts` never had.
- Root cause, found via `npm view prisma dist-tags`: npm's `latest` tag for the `prisma` package currently points to `8.0.0-rc.23`, an **unreleased release candidate**, not a stable version. At some point after the Phase 0 install (which genuinely did land on `7.10.1` — confirmed by that install's own install-scripts warning naming that exact version), a later `npm install` silently re-resolved to this RC. `package.json` had `"prisma": "^8.0.0-rc.23"`; `npx prisma --version` confirmed `8.0.0-rc.23` was what was actually running.
- That one fact explained every surprise: the CLI restructuring, the broken config import (`prisma7.config.ts` imports `defineConfig`, but the RC's `prisma/config` module exports `definePrismaConfig` instead — a real rename between versions), the missing `migrate`/`format`/`studio` commands.

**Fix:** `npm install --save-exact prisma@7.10.1 @prisma/client@7.10.1 -w packages/server`, pinning both to the exact last stable release instead of letting semver/latest resolve freely. Re-verified `generate`, `format`, and `--version` all work correctly afterward — and `prisma format` actually reformatted the hand-typed `User` model fields into the aligned style, closing the loop on the formatting question that started this.

**Trap flagged for later:** `prisma format`'s own "Update available" banner suggests `npm i --save-dev prisma@latest` — doing that would re-introduce this exact problem, since `latest` is still the RC. Documented in `phase_0_implementation.md` under "Known pitfall: pin the Prisma version" so it doesn't get hit again.

### 3. Two missing dependencies, surfaced before they became a runtime surprise

Neither `bcrypt` (password hashing, required by architecture.md §10) nor `cookie-parser` (reading the JWT from an httpOnly cookie) were installed from Phase 0. Both added in the Phase 1 plan, along with their `@types/*` packages (needed because neither ships its own TypeScript declarations).

### 4. A guard the architecture doc implied but never named

Architecture.md §7 marks several routes "optional" auth (viewing a public task needs no login), but the standard `AuthGuard('jwt')` throws `401` on a missing token — incompatible with anonymous access. Added `OptionalJwtAuthGuard` (overrides `handleRequest` to return `null` instead of throwing) alongside the required `JwtAuthGuard`, so `TaskAccessGuard` can check `req.user` whether or not the requester is logged in.

### 5. Still unresolved: e2e test data collisions

`test/tasks.e2e-spec.ts` (phase_1_implementation_plan.md Step 6) writes real rows through the real `PrismaService` against whatever `DATABASE_URL` the app resolves — currently the local dev database. Running it more than once will collide with the `email` `@unique` constraint. Flagged, not resolved — needs a decision (separate `tasks_app_test` database, per-test transaction rollback, or `afterEach` cleanup) before that test is runnable repeatedly.

## Concepts covered

### Testing in this project

Corrected an assumption in `implementation-plan.md`: this project's `nest new` scaffold uses **Vitest**, not Jest. Two layers exist: unit specs (`*.spec.ts`, colocated in `src/`, `npm run test`) and e2e specs (`*.e2e-spec.ts`, in `test/`, using `supertest` against a fully booted `AppModule`, `npm run test:e2e`).

### NestJS building blocks

- **Decorators** (`@Injectable`, `@Controller`, `@Get`, `@UseGuards`, etc.) attach metadata Nest reads at startup to wire up DI and routing — they don't execute logic themselves.
- **Interfaces** (`OnModuleInit`, `OnModuleDestroy`, `CanActivate`) are compile-time-only contracts. For lifecycle hooks specifically, Nest doesn't check the interface at runtime — it duck-types by method name (`onModuleInit` must exist and be spelled correctly); `implements X` is there for the compiler to enforce that on your behalf, not something Nest inspects.
- DTOs are written as **classes**, not interfaces, specifically because `class-validator` decorators (`@IsString()`, `@IsIn()`) need a real runtime class to attach to — an interface is erased at compile time and has nothing for a decorator to land on.
- **`PrismaModule`'s `@Global()`**: registers `PrismaService` once in `AppModule` and makes it injectable everywhere without every feature module needing `imports: [PrismaModule]`. The explicit-imports alternative (listing `PrismaModule` in every consuming module) makes dependencies more visible per-file, at the cost of repetition — but a shared DB client is one of the cases Nest's own docs consider a legitimate use of `@Global()`, so what's already there isn't a misuse.
- **Why `AppModule` has to import a module for it to do anything**: Nest builds its whole DI graph by walking `imports` starting from the root (`NestFactory.create(AppModule)` in `main.ts`). A module that exists on disk but isn't reachable through that walk is effectively dead code — its providers are never constructed, and lifecycle hooks like `PrismaService.onModuleInit()` never fire.

### `npm`/workspace mechanics

- `-w <path>` targets a specific workspace member for an install, equivalent to `cd`-ing into it first — but the root package itself isn't a "workspace," so installing into the root `package.json` means *omitting* `-w` entirely.
- `-D` (`--save-dev`) puts a package in `devDependencies` instead of `dependencies` — the split is runtime-required (ships to production) vs. only needed while developing/building/testing (type packages, test runners, linters). Compiled JS has no idea a `.d.ts` file ever existed, so `@types/*` packages are always `-D`.
- `@types/<package>` is needed whenever a package is plain JS with no bundled TypeScript declarations (`passport-jwt`, `cookie-parser`, `bcrypt`) — `@nestjs/*`, `class-validator`, `ioredis`, etc. ship their own types and need no separate package.

### Prisma schema language (PSL)

- **Schema-first vs. Rails' migration-first**: Rails hand-writes imperative migrations and auto-generates `schema.rb` as a derived snapshot (never hand-edited). Prisma flips this — you hand-write `schema.prisma` as the declarative end-state, and `prisma migrate dev` auto-generates the SQL migration file by diffing it against the database. The thing you hand-write and the thing that's generated are swapped between the two frameworks. (Prisma also supports the reverse direction, `db pull`/introspection, for adopting an already-existing database — not what this project needs, since it's starting from empty.)
- **Formatting**: the column-aligned spacing in `schema.prisma` isn't typed by hand — it's `prisma format` (or the VS Code extension's format-on-save), the same category of tool as `gofmt`. A human types one space; the formatter pads the rest.
- **`@` vs `@@`**: single `@` is a field-level attribute, written on that field's own line (`email String @unique`). Double `@@` is a block-level attribute, applying to the whole `model` (`@@map("users")`, `@@index([ownerId])`) — needed whenever something spans multiple fields or renames the model as a whole, which no single field's attribute could express.
- **`@@map`**: renames the actual SQL table without changing the PascalCase singular model name (`User`) used in code — bridges Prisma's naming convention and typical SQL (`users`, lowercase plural) convention.
- **`uuid()`**: generates a random 128-bit identifier per row, not a sequential integer — the opposite of auto-increment. Chosen so ids can't be enumerated by a client guessing nearby values (unlike sequential ints, which leak existence/count information), at the cost of larger storage (36-char string vs. 4–8 bytes) and worse index locality at very large scale.
- **`@relation`**: Prisma's equivalent of Rails' `belongs_to`/`has_many`, but always declared as a matching pair across both models rather than a single macro call. The side holding the actual foreign-key column writes the full `@relation(fields: [...], references: [...])` (the "belongs_to" side); the other side is a bare array or optional type with no attribute at all (the "has_many" side, inferred automatically). This is the *only* mechanism PSL has for relations — there's no Rails-style one-line call — but cardinality changes the shape: one-to-one adds `@unique` on the FK side; many-to-many can be implicit (two array fields, Prisma manages a hidden join table — closest to `has_and_belongs_to_many`) or explicit (your own join model with extra columns, like `has_many :through`); self-relations or multiple relations between the same two models need a `@relation("Name")` label so Prisma can tell which fields pair with which.
