# Debugging Notes & Methodology

A running collection of debugging approaches used while building this app — not a changelog of bugs, but a record of *how* each one got found, so the method is reusable even once the specific bug isn't relevant anymore. Add to this as new debugging episodes come up.

## General guidelines

1. **In this monorepo, CLI tools discover config based on current directory, not target file path.** `prisma`, `tsx`, and most Node tooling walk upward from *cwd* looking for `tsconfig.json`/`schema.prisma`/etc. — not from the file you pass as an argument. Always `cd packages/server` (or whichever package) before running its tooling, even if you're passing an absolute path to the file. Bit twice this session in two different tools (`prisma migrate dev`, then `tsx`) before it became a standing rule instead of a fresh surprise each time.

2. **A CLI command succeeding is not proof the application works.** Prisma's CLI (`generate`, `migrate dev`, `studio`) and the actual `PrismaClient` your app code imports can have *independently configured* connection paths — in this project's case, the CLI reads `prisma7.config.ts` (which loads `.env` itself), while the running Nest app never touched that file at all. Verifying one told us nothing about the other. If two things share a package name but are invoked through different entry points, don't assume one being verified means the other is too.

3. **Read the full error text before theorizing.** Prisma's errors in particular tend to print the exact fix inline (import path, example code). `npm view <pkg> dist-tags` directly answers "what does `latest` actually point to" instead of guessing. Cheaper to read than to reason from first principles.

4. **Form a hypothesis, then confirm it directly — don't stop at "that sounds right."** Every fix in this doc's case log was verified by actually re-running something and observing the specific error disappear, or by printing the actual runtime value in question (`process.env.DATABASE_URL`, `npx prisma --version`), not by reasoning alone and moving on.

5. **An unpinned dependency can silently drift out from under you.** `npm install <pkg>` with no version resolves to whatever `latest` means *right now* — which is not guaranteed to be a stable release. Pin exact versions for anything where this would be expensive to get wrong (`--save-exact`), and periodically re-check what's actually installed (`npx <tool> --version`) rather than trusting the version from whenever you first ran the install.

6. **"It boots" and "it works" are different claims — a health check that never touches the real dependency chain doesn't verify that chain.** The default `GET /` route never queried the database, so the app "boots and responds" was true long before `PrismaService` could actually connect. A verification step needs to exercise the specific thing being verified, not just adjacent things.

7. **A live REPL/sanity-check beats reading code and assuming it's correct.** NestJS's built-in `repl()` (or a throwaway `tsx` script for something narrower, like one DTO's validators) runs the real code path, with the real DI container, against the real database. This is what actually surfaced issues #3 and #4 in the case log below — nothing about reading `prisma.service.ts` would have revealed either on its own.

8. **A TypeScript "not assignable" error usually already contains the fix — read to the deepest nested line, not just the first.** For a method-override error specifically, TS reprints the base class/interface's actual signature as part of the message (no need to go hunting for it first), and the deepest line is typically the real explanation, not a restatement (`'TUser' could be instantiated with an arbitrary type which could be unrelated to '{} | null'` was the actual root cause in case #9 — three lines past where a quick glance usually stops). If the error still isn't self-explanatory enough, the library's real `.d.ts` is sitting in `node_modules` and is authoritative, not documentation that might be stale: `grep -rn "<methodName>" node_modules/<package>/dist/*.d.ts`. Once a fix looks right, write it to a throwaway file and compile it for real before trusting it — same discipline as guideline 4, applied specifically to type errors.

## Useful commands

**Prisma CLI** (always from inside `packages/server`):
```bash
npx prisma --version              # confirm what's ACTUALLY installed, not what you think you installed
npx prisma validate                # schema syntax check, no DB needed
npx prisma format                  # auto-align schema.prisma
npx prisma generate                # regenerate the client (also run automatically by migrate dev)
npx prisma migrate dev --name X    # diff schema vs DB, generate + apply migration SQL
npx prisma studio                  # GUI against the real DB — good first check after any schema change
```

**Checking what a package's `latest` tag actually resolves to** (useful before any unpinned install of something critical):
```bash
npm view <package> dist-tags --json
```

**Quick runtime checks, without booting the whole app**:
```bash
npx tsx -e "console.log(process.env.DATABASE_URL)"   # is an env var actually loaded at runtime?
npx tsc --noEmit -p tsconfig.json                     # type-check only, no build output
```

**One-off script against real project code** (for checking one class/function in isolation — e.g. a DTO's validators):
- Write the script *inside* the package whose `node_modules` it needs (not the scratchpad — bare imports like `class-validator` resolve from the script's own location, and the scratchpad is outside the project tree).
- Wrap any `await` in an `async function main() { ... } main();` — `tsx` runs loose scripts as CJS, which disallows top-level `await`.
- Run with `npx tsx <file>.ts` from inside that package's directory.
- Delete the file when done.

**NestJS REPL** (the real equivalent of `rails console` — boots the actual DI graph, real DB connection, no HTTP listener):
```ts
// packages/server/src/repl.ts
import { repl } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  await repl(AppModule);
}
bootstrap();
```
```bash
cd packages/server && npx tsx src/repl.ts
```
Inside: `get(SomeService)` pulls the real injected instance; `methods(SomeService)` lists what's callable; `debug()` prints the module tree. Only works for providers actually reachable from `AppModule`'s import graph — same rule as any other DI resolution.

**Docker**:
```bash
docker compose ps        # is the container actually up, before assuming a connection bug is code-level
docker compose logs -f   # tail logs when something looks wrong
```

## Case log

Short entries — what broke, how it was actually found, what fixed it. Full narrative context for the first four lives in [phase_1_notes.md](./phase_1_notes.md); this is the condensed, reusable version.

| # | Symptom | How it was found | Root cause | Fix |
|---|---|---|---|---|
| 1 | `prisma migrate dev` → "Could not find Prisma Schema" | Checked the terminal prompt in the pasted output — cwd was the repo root, not `packages/server` | Prisma CLI looks for `./prisma/schema.prisma` relative to cwd | `cd packages/server` before any Prisma command |
| 2 | `prisma format`/`migrate`/`studio` → unknown command; totally different CLI surface than expected | `npx prisma --help` showed an unfamiliar "Developer Platform" CLI; `npm view prisma dist-tags` showed `latest` pointed at `8.0.0-rc.23`, an unreleased RC | Unpinned `npm install prisma @prisma/client` had silently drifted from the originally-installed `7.10.1` to the RC at some point | `npm install --save-exact prisma@7.10.1 @prisma/client@7.10.1`; documented the trap in `phase_0_implementation.md` |
| 3 | `repl.ts` → "Cannot find module './app.module.js'" | Read the file's own tab path in the IDE screenshot — it was at the repo root `src/`, not `packages/server/src/` | File created in the wrong directory | Moved the file; deleted the stray root-level `src/` |
| 4 | `repl.ts` → `TypeError: Cannot read properties of undefined (reading 'value')` inside a Nest decorator | Recognized the error shape (decorator called with `descriptor` undefined) as a legacy-vs-TC39-decorators transform mismatch; connected it to the command being run from the repo root instead of `packages/server`; confirmed by re-running from the correct directory | `tsx` discovers `tsconfig.json` (and its `experimentalDecorators: true`) from cwd, not from the target file's location | Always run `tsx` from inside `packages/server` |
| 5 | `repl.ts` → `PrismaClientInitializationError: ... A driver adapter is required` | Error message stated the fix directly, including the exact import and code pattern | This Prisma client generator requires an explicit driver adapter; never caught before because `prisma generate`/`migrate dev` use a separate connection path that doesn't need one | Installed `@prisma/adapter-pg`, `pg`, `@types/pg`; added `PrismaPg` to `PrismaService`'s constructor |
| 6 | `repl.ts` → `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string` | Direct test: `npx tsx -e "console.log(process.env.DATABASE_URL)"` → `undefined` — checked the actual runtime value instead of assuming `.env` was loaded | `.env` was only ever loaded by the Prisma CLI (via `prisma7.config.ts`'s own `dotenv/config` import); the real Nest app never loaded it | Registered `ConfigModule.forRoot({ isGlobal: true })` in `AppModule` |
| 7 | `jwt.strategy.spec.ts` → `TypeError: JwtStrategy requires a secret or key`, despite `JWT_SECRET` genuinely being in `.env` | Forced a test to assert on the actual value (`expect(process.env.JWT_SECRET).toBe('...')`) instead of trusting it was loaded — confirmed `undefined` | A *third* independent runtime (Vitest) that doesn't share env-loading with the CLI or the real app either — unit tests that `new` a class directly never go through `AppModule`'s `ConfigModule` at all | Set the value directly in the test (`beforeAll(() => { process.env.JWT_SECRET = 'test-secret'; })`) rather than relying on `.env` — the more correct fix anyway, since a unit test shouldn't depend on a real secret from a file that might not exist in CI |
| 8 | `jwt.strategy.ts` → `TS2345`, error text mentions `jwtFromRequest`/Express `Request` generics | Read the *full* unfiltered `tsc` output, not just the summary line a `grep` had cut off earlier — the real cause was several lines further down | `secretOrKey: process.env.JWT_SECRET` is typed `string \| undefined`; `passport-jwt`'s types require `string \| Buffer`. The `jwtFromRequest`/`Request` text earlier in the error was TypeScript's structural-comparison noise, not the actual blocking field | Guard with an early throw (`if (!secretOrKey) throw ...`) before calling `super()` — narrows the type and replaces a confusing library-internal error with a clear one |
| 9 | `optional-jwt-auth.guard.ts` → `TS2416`: `handleRequest` not assignable to base type | Wrote two candidate fixes to a throwaway file (`_test-guard.ts`) and compiled each against this project's real installed `@nestjs/passport`, instead of guessing which one was right | `@nestjs/passport`'s `IAuthGuard.handleRequest` is a *generic* method (`<TUser = any>(...) => TUser`); overriding it with a non-generic, concretely-typed version doesn't satisfy "works for any `TUser`" | Made the override generic too (`handleRequest<TUser = any>(err: any, user: any): TUser`), cast the return to `TUser` — and this was a real bug in the plan doc itself, never compiled before the user hit it |
| 10 | `create-task.dto.ts` → `TS2307: Cannot find module '../../generated/prisma/client.js'` | Counted the actual directory levels between the file's real location (`src/tasks/dto/`) and `generated/` (a sibling of `src/`, both directly under `packages/server/`) — three `..` needed, only two were written — then confirmed with `tsc` rather than trusting the arithmetic alone | Plan doc (`phase_1_implementation_plan.md`) had the wrong relative path — written without ever compiling it against the file's real location | Fixed to `'../../../generated/prisma/client.js'`, in both the real file and the plan doc |
| 11 | `create-task.dto.ts` → `TS2305: Module has no exported member 'TaskVisibility'`, even after fixing the path | Read `generated/prisma/enums.ts` directly instead of assuming the import itself was still wrong — it literally said "This file is empty because there are no enums in the schema," despite `schema.prisma` clearly having both enums | The generated Prisma client had gone stale — generated against an older version of the schema (before the enums were added) and never regenerated since, even though the database itself already had both enum types from the `add_core_models` migration | `npx prisma generate` — re-run, regenerated `enums.ts` with the real exports. General lesson: if something imported from `generated/prisma/` claims a type doesn't exist despite the schema clearly having it, regenerate before digging further — it can silently drift out of sync |
