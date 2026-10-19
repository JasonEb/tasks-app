# Phase 1 Implementation — Session Review

A retrospective of the full Phase 1 session: everything built, every hurdle hit, the design calls made along the way, and the questions asked with their answers. See [phase_1_implementation_plan.md](./phase_1_implementation_plan.md) for the living plan this session executed, and [debugging-notes.md](./debugging-notes.md) for the full case-log detail behind the hurdles summarized here.

## Where things ended up

By the end of this session: `schema.prisma` has `User`/`Task`/`Comment` models plus `TaskStatus`/`TaskVisibility` enums, two migrations applied; `AuthModule` (DTOs, `AuthService`, `JwtStrategy`, both guards, `AuthController`) and `TasksModule` (`CreateTaskDto`, `TaskAccessGuard`, `TasksService`, `TasksController`) are both built and registered in `AppModule`; the full test suite is green — `npm run test` (14 tests, 6 files) and `npm run test:e2e` (2 tests, confirmed repeatable).

## Hurdles encountered

Condensed list — full symptom/diagnosis/fix detail for each lives in `debugging-notes.md`'s case log.

- **Prisma silently drifted to an unreleased `8.0.0-rc.23`** release candidate, explaining a cascade of CLI surprises (restructured command surface, broken generated config, dead `migrate`/`format`/`studio` commands) before being traced to `npm`'s `latest` tag and pinned back to `7.10.1`.
- **Four bugs surfaced only by actually running the Nest REPL** (`src/repl.ts`): wrong file location, a decorator crash from running `tsx` outside `packages/server`, `PrismaClient` needing an explicit driver adapter, and `.env` never being loaded by the real app (only by the Prisma CLI) — none of these were visible from reading the code.
- **Three TypeScript type errors in the auth guards/strategy**, each requiring reading the *full* nested error rather than a summary line: `JwtStrategy`'s `secretOrKey` being `string | undefined`, `OptionalJwtAuthGuard`'s `handleRequest` needing to stay generic to match its base interface, and a spec importing `extractTokenFromCookie` without actually exporting/importing it correctly at first.
- **A stale generated Prisma client** — `generated/prisma/enums.ts` still said "no enums in the schema" well after enums were added, fixed by re-running `prisma generate`.
- **A miscounted relative import path** (`../../generated/...` vs the correct `../../../generated/...`) — caught by actually compiling, not by trusting the arithmetic.
- **The e2e test debugging marathon** — five issues, each hidden behind the last: `AuthModule`/`TasksModule` never registered in `AppModule` (blanket 404s), no cleanup between e2e runs (stale duplicate email), `.env.test` missing `JWT_SECRET`, `auth.controller.ts`'s `login` never actually calling `res.cookie(...)`, and finally `secure: true` on that cookie silently breaking it in test since supertest's in-process requests aren't real HTTPS.
- **Several hand-typed bugs along the way**: a `contructor` typo breaking Nest's parameter-property DI wiring, `await.this` (stray dot) breaking a controller method, an extra paren mangling a decorator's parameter list, a `TaskAccessguard`/`TaskAccessGuard` casing mismatch producing a misleading "not a constructor" error, and a test with all-`true` expected values that would have passed even against a guard with no real logic at all.

## Design choices made this session

**Prisma `enum`s instead of `String` + DTO-only validation for `status`/`visibility`.** architecture.md's `check (... in (...))` constraints aren't expressible in Prisma's schema language; native enums give the same database-level guarantee (Postgres rejects an invalid value outright) without hand-maintained SQL, and `@IsEnum()` validates against the same generated enum rather than a separately hardcoded list that could drift.

**Different `ON DELETE` behavior for the two foreign keys pointing at `users`.** `Task.owner` stays `RESTRICT` — cascading would silently destroy other people's comments on that task. `Comment.author` is `SET NULL` and nullable — `RESTRICT` here would make account deletion nearly impossible once a user has commented anywhere; the content outlives the commenter, same pattern most forums use.

**Restructured `phase_1_implementation_plan.md` to test-first (TDD) ordering**, on request, for everything not yet built at the time — but deliberately *not* for every file. Real logic (a guard's authorization check, a service's query-scoping, a strategy's payload mapping) gets a spec written first; thin wiring (bare guard subclasses, controllers that just delegate, modules) gets none, verified by the e2e test instead. Treated as a judgment call, not "test everything."

**Separate `tasks_app_test` database + table-clearing, not transaction-wrapping, for e2e test isolation.** Transaction-wrapping is faster but requires every query in a request to share one open transaction — real setup complexity (a custom harness or a library like `nestjs-cls`) not worth it yet at one e2e spec. A second database avoids both polluting dev data and that complexity.

**Cookie `secure` flag made conditional on `NODE_ENV`, not hardcoded `true`.** Correct and necessary in production (real HTTPS); hardcoded `true` silently broke authentication in local/test HTTP environments, since a `Secure` cookie is never resent over a non-TLS connection — same behavior a real browser enforces.

## Questions asked, with answers

### NestJS concepts

```
what does the prisma module do
```
A `@Module()` groups related providers/controllers and declares what's shared via `exports`. `PrismaModule` registers `PrismaService` as a provider, exports it, and marks itself `@Global()` so every other module can inject it without each one listing `imports: [PrismaModule]` individually — justified here since a shared DB client is one of the recognized legitimate uses of `@Global()`, not a shortcut.

```
what does Register PrismaModule in AppModule do for the app
```
Nest builds its whole DI graph by walking `imports` starting from `AppModule` (`NestFactory.create(AppModule)` in `main.ts`). A module that exists on disk but isn't reachable through that walk is dead code — its providers are never constructed, lifecycle hooks like `onModuleInit()` never fire.

```
what's better than reaching for Global()
```
Explicit `imports` in every consuming module — makes real dependencies visible per-file at the cost of repetition. Reserved for genuinely feature-specific providers; a shared DB client (what `PrismaModule` actually is) is one of the cases Nest's own docs consider a legitimate `@Global()` use, not a misuse.

```
in the context Nest.js what does decorator and interface mean, how will it relate to Tasks or Users
```
Decorators (`@Controller`, `@Get`, `@UseGuards`) attach metadata Nest reads at startup for routing/DI; they don't execute logic themselves. Interfaces (`OnModuleInit`, `CanActivate`) are compile-time-only — for lifecycle hooks specifically, Nest duck-types by method name rather than checking the interface at runtime. DTOs have to be classes, not interfaces, specifically because `class-validator` decorators need a real runtime class to attach to.

```
what is the purpose of task.module, is it to expose and tie all the tasks code together to the nextjs system
```
Yes (NestJS, not Next.js) — ties `TasksController`/`TasksService`/`TaskAccessGuard` into one DI-visible unit, and `imports: [AuthModule]` specifically so its routes can use the guards `AuthModule` exports.

```
in the context of nestjs, is this task service an example of a provider
```
Yes — "provider" is the umbrella term for anything `@Injectable()`; "service" is just the conventional name for one role within that category (business logic/data access), alongside "guard" and "strategy" as other roles under the same mechanism.

```
export class AuthModule {} what's the purpose of the {}
```
Ordinary class syntax — every class needs a body. It's empty because `@Module({...})` does all the actual work as attached metadata; the class itself is never instantiated by app code, only used as a DI token.

```
what's ExecutionContext
```
The parameter every `CanActivate` guard receives — an abstraction over "the current request," deliberately generic across HTTP/WebSocket/RPC transports. Narrowed via `context.switchToHttp().getRequest()` etc. The error message for a failed guard override literally reprints the base interface's real signature, which is how the `handleRequest<TUser>` fix got found rather than guessed.

### Prisma / database concepts

```
is this the only way to establish has_may and belongs_to relationships with Prisma, are there any other methods that handles it explicitly like in Rails
```
Two-sided field declaration (one side with `@relation(fields, references)`, the other a bare array/optional type) is the only mechanism — no one-line macro equivalent. Cardinality varies the shape: one-to-one adds `@unique` on the FK side; many-to-many can be implicit (hidden join table) or explicit (your own join model, for `has_many :through`-style extra columns); self-relations need a `@relation("Name")` label.

```
how are these enums managed by Prisma, are these columns that are interpreted on a Next.js level
```
Two separate representations, not one: a real Postgres `CREATE TYPE ... AS ENUM`, enforced by the database regardless of what writes to it, plus a generated TypeScript mirror (`generated/prisma/enums.ts`) used for compile-time safety and `@IsEnum()`'s runtime check. `schema.prisma` is the single source; `migrate dev` keeps both in sync automatically.

```
what is this generated directory how come it's not track in the vs code explorer
```
Real build output from `prisma generate`, gitignored (added automatically by `prisma init`) since it's fully derivable from `schema.prisma`. (Turned out to be a VS Code file-watcher lag after the folder was created by an external CLI process, not a git/settings issue.)

```
how was this migration made, was it generated
```
Generated, not hand-written — `prisma migrate dev` diffs `schema.prisma` against the real database and computes the SQL itself. The inverse of Rails: Rails hand-writes migrations and auto-generates `schema.rb`; Prisma hand-writes the declarative schema and auto-generates the imperative migration SQL.

```
was this migration made in phase 0
```
No — there's only one migration in the actual history (`add_core_models`); the planned empty Phase 0 verification migration never actually completed, likely lost in the Prisma version-drift incident.

### TypeScript / JS language concepts

```
what does "@@" mean "@@"map("users")
```
Single `@` is a field-level attribute (one property, same line). Double `@@` is block-level, applying to the whole model — needed for anything spanning multiple fields or renaming the model as a whole (`@@map`, `@@index`).

```
how does uuid() work, is it an integer incrementing by 1
```
No — random, not sequential. Chosen specifically so ids can't be enumerated by a client guessing nearby integers, at the cost of storage size and worse index locality versus auto-increment.

```
is there a way to quickly sanity check dto/register.dto.ts
```
A throwaway `tsx` script, written *inside* the package whose `node_modules` it needs (not the scratchpad — bare imports resolve from the script's own location), using `class-transformer`'s `plainToInstance()` + `class-validator`'s `validate()` — the same call `ValidationPipe` makes internally.

```
there's no way to sanity check this on the fly like how i can with Rails + irb?
```
There is — `@nestjs/core`'s built-in `repl()`, booting the real DI container (no HTTP listener) with `get(SomeService)`/`methods()`/`debug()` helpers. Closest real equivalent to `rails console`, as opposed to the narrower throwaway-script approach above.

```
(user ?? null) as TUser; what does ?? mean
```
Nullish coalescing — falls back to the right side only for `null`/`undefined`, unlike `||` which falls back for any falsy value (`0`, `''`, `false` too). Normalizes Passport's `undefined`-on-failure into a consistent `null`.

```
what is the purpose of index.ts
```
Node/TypeScript's default resolution target for a bare directory import — not special on its own, but wired up here via `package.json`'s `main`/`types` fields pointing at it. Acts as the published surface of the `shared` package; everything importable from `@tasks-app/shared` has to be exported from this one file.

### Testing / TDD concepts

```
I prefer TDD, where I write tests/specs first then implement. Does my implementation plans consider that
```
No, honestly — the plan as originally written was implementation-first (code, then a spec describing what already existed), confirmed by how `auth.service.spec.ts` was actually built in practice. Restructured from `jwt.strategy.ts` onward.

```
when it comes to creating modules within specs, do we always .compile(). When is .compile() used
```
Only relevant when `Test.createTestingModule(...)` is used in the first place — plenty of specs (`TaskAccessGuard`, `OptionalJwtAuthGuard`, `JwtStrategy`) just `new` the class directly and skip it entirely. When it *is* used, `.compile()` is mandatory — the builder does nothing until called; `.get()` doesn't even exist on the uncompiled type.

```
what's the best way to do it then if not beforeEach
```
Split concerns: `beforeAll` for the expensive one-time setup (compiling the module, initializing the app), `beforeEach` for the cheap per-test part (clearing rows). Confirmed in practice — this exact split is what made the e2e suite pass repeatably.

### Debugging methodology

```
what was your methodology for debugging each of those issues, how could we have been aware about this before
```
Varied by issue, but the throughline: running something from the wrong directory in a monorepo (hit twice, different tools) and treating "the CLI works" as proof "the app works" (two genuinely separate connection paths) were the two root patterns underneath four distinct-looking bugs.

```
how did we determine this needed a TUser. what steps should a human do to investigate and determine the solution
```
Read the full error (it already reprints the base method's real generic signature) → read the deepest nested line, usually the actual explanation, not the first line → recognize the general TS rule (a concrete override can't satisfy a generic base method) → optionally cross-check the real `.d.ts` in `node_modules` → write the candidate fix and compile it for real before trusting it.
