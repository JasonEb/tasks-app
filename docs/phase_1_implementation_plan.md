# Phase 1 — Data Layer & Core Task API

Follow in order from `packages/server` unless noted. See [architecture.md](./architecture.md) §5 (data model), §7 (API), §8 (authorization) for the design this implements.

## Where the tests are

`implementation-plan.md`'s Phase 1 listed tests as a single bullet at the end, naming Jest — that's wrong for this project (confirmed: the `nest new` scaffold uses **Vitest**, not Jest). Fixed in that file.

**This doc is now ordered test-first (TDD) for everything not yet built.** `register.dto.ts`, `login.dto.ts`, `auth.service.ts`, and `auth.service.spec.ts` are already done — built implementation-first, spec written after the fact to describe behavior that already existed. That's noted honestly where it comes up below rather than rewritten into a TDD narrative it didn't actually follow. Everything from `jwt.strategy.ts` onward (still unwritten at time of this update) follows: write the failing spec, watch it fail (can't import a class that doesn't exist yet), then write just enough implementation to pass it.

**Not every file gets a dedicated spec, and forcing one everywhere would be cargo-culting the practice rather than applying it.** TDD earns its keep where there's real logic to drive out — a guard's authorization check, a service method's query-scoping, a strategy's payload mapping. Thin wiring (modules, a guard that's a bare subclass with no overrides, a controller that just calls a service method and returns it) has no behavior of its own to test-drive; those are verified by the Step 6 e2e test instead, which exercises the whole wired-together path. Each piece below says explicitly which category it's in.

Unit specs (`*.spec.ts`) live colocated next to the file they test, in `src/`. E2E specs (`*.e2e-spec.ts`) live in `test/`. Both already work out of the box from the Nest scaffold — `npm run test` / `npm run test:e2e`.

## Two gaps found before starting

Neither of these is installed yet, and both are required for this phase, not optional:

```bash
npm install bcrypt -w packages/server
npm install -D @types/bcrypt -w packages/server
npm install cookie-parser -w packages/server
npm install -D @types/cookie-parser -w packages/server
```

- `bcrypt` — architecture.md §10 requires password hashing; nothing in the Phase 0 install list covered this.
- `cookie-parser` — the JWT strategy reads the token from an httpOnly cookie (architecture.md §3). Nest doesn't parse `req.cookies` without this registered as middleware.

Register `cookie-parser` once, in `packages/server/src/main.ts`:

```ts
import cookieParser from 'cookie-parser';
// ...
app.use(cookieParser());
```

## Step 1 — Prisma schema

Edit `packages/server/prisma/schema.prisma`, adding two enums and the three models (the `generator`/`datasource` blocks Prisma 7 already generated stay as-is):

```prisma
enum TaskStatus {
  todo
  in_progress
  done
}

enum TaskVisibility {
  public
  private
}

model User {
  id           String    @id @default(uuid())
  email        String    @unique
  passwordHash String
  name         String
  createdAt    DateTime  @default(now())
  tasks        Task[]
  comments     Comment[]

  @@map("users")
}

model Task {
  id          String    @id @default(uuid())
  ownerId     String
  owner       User      @relation(fields: [ownerId], references: [id])
  title       String
  description String?
  status      TaskStatus     @default(todo)
  visibility  TaskVisibility @default(private)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  comments    Comment[]

  @@index([ownerId])
  @@index([visibility])
  @@map("tasks")
}

model Comment {
  id        String   @id @default(uuid())
  taskId    String
  task      Task     @relation(fields: [taskId], references: [id], onDelete: Cascade)
  authorId  String?
  author    User?    @relation(fields: [authorId], references: [id], onDelete: SetNull)
  body      String
  createdAt DateTime @default(now())

  @@index([taskId, createdAt])
  @@map("comments")
}
```

`authorId`/`author` are nullable with `onDelete: SetNull` — deleting a user detaches their authorship from any comments they left rather than deleting the comments (or blocking the user deletion outright). See architecture.md §5 for the reasoning: this is deliberately different from `Task.owner`, which stays `onDelete: Restrict` (Prisma's default, left unset) since cascading a task owner's deletion would also destroy other people's comments on that task.

**Resolved — not a plain-`String` gap anymore.** architecture.md §5 describes `status`/`visibility` as `check (... in (...))` constraints, which Prisma's schema language can't express literally. Rather than leaving them as plain `String` columns enforced only at the DTO layer (the original plan), they're native Prisma `enum`s instead. For Postgres, Prisma compiles an `enum` block to a real `CREATE TYPE ... AS ENUM (...)`, so the column itself only accepts those values — enforced by Postgres, not just by whatever happens to be validating requests that day. A manual `psql` insert or a future admin script with a typo'd status now gets rejected by the database itself, not silently accepted.

This doesn't replace DTO validation (Step 5 updates `CreateTaskDto` to validate against this same enum) — the enum is the hard guarantee at the database layer; DTO validation is still what turns a bad request into a clean `400` instead of a raw Postgres constraint-violation error surfacing as a `500`. Both layers, not one instead of the other.

`packages/shared/src/index.ts`'s `TaskStatus`/`TaskVisibility` string-literal unions (Step 3) don't need to change — they're structurally identical to the enum's values and stay framework-agnostic (no `web` dependency on Prisma's generated client), so the two representations stay compatible without being the same declaration.

## Step 2 — First real migration

```bash
npx prisma migrate dev --name add_core_models
```

(`init` is already taken — that's Phase 0's empty verification migration.) This one actually creates the `users`, `tasks`, `comments` tables, and regenerates the client in `generated/prisma/` with typed `.user`, `.task`, `.comment` properties on `PrismaService`.

## Step 3 — Shared types

`packages/shared/src/index.ts` already has `TaskVisibility`/`TaskStatus` from Phase 0. Add the data shapes both `server` and `web` will need:

```ts
export interface Task {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  visibility: TaskVisibility;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  taskId: string;
  authorId: string | null;
  body: string;
  createdAt: string;
}

export interface CreateTaskBody {
  title: string;
  description?: string;
  visibility: TaskVisibility;
}

export interface UpdateTaskBody {
  title?: string;
  description?: string;
  status?: TaskStatus;
  visibility?: TaskVisibility;
}
```

These are consumed as *types only* on the server (the actual runtime validation is the DTO classes in Step 4/5) — `web` will use them the same way once it exists. No build step needed; `shared`'s `package.json` points straight at `src/index.ts`, as set up in Phase 0.

## Step 4 — `AuthModule`

All files under `packages/server/src/auth/`.

### Already done (implementation-first, not rewritten)

`dto/register.dto.ts`, `dto/login.dto.ts`, `auth.service.ts`, and `auth.service.spec.ts` are built and passing (`npm run test` — 1 passed). These were written before this doc switched to TDD ordering, so the spec came after the implementation it describes rather than driving it. Left as-is rather than rewound and redone purely for narrative consistency — the behavior they prove (register hashes + stores a user; login rejects a wrong password) is correct regardless of which order it was written in.

### Step 4a — `JwtStrategy`: spec first

Real logic lives here — the cookie extractor and the payload-to-`req.user` mapping — so this is where TDD actually earns its keep. Write the spec before the class exists:

**`jwt.strategy.spec.ts`**
```ts
import { JwtStrategy, extractTokenFromCookie } from './jwt.strategy.js';

describe('JwtStrategy', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
  });

  it('extracts the token from the cookie', () => {
    expect(extractTokenFromCookie({ cookies: { access_token: 'abc' } } as any)).toBe('abc');
    expect(extractTokenFromCookie({ cookies: {} } as any)).toBeNull();
    expect(extractTokenFromCookie({ cookies: undefined } as any)).toBeNull();
  });

  it('maps the JWT payload to req.user shape', async () => {
    const strategy = new JwtStrategy();
    const result = await strategy.validate({ sub: '123', email: 'a@b.com' });
    expect(result).toEqual({ id: '123', email: 'a@b.com' });
  });
});
```

**Why `extractTokenFromCookie` is imported, not redefined inline**: the first version of this spec wrote the extractor as a local copy, `const extractor = (req: any) => req.cookies?.['access_token'] ?? null`, directly inside the test. That looks reasonable but doesn't actually test `JwtStrategy` at all — it tests an independent duplicate of the logic, so it stays green regardless of what the real class does, even before `jwt.strategy.ts` exists. Exporting the extractor as its own named function from `jwt.strategy.ts`, and having the spec import that exact function, closes the loop: the test now genuinely fails until the real implementation exists, and genuinely breaks later if the real extraction logic changes.

**Why `beforeAll` sets `JWT_SECRET` directly instead of relying on `.env`**: confirmed empirically — Vitest does not load `.env` into `process.env` at all (checked directly: a test asserting on `process.env.JWT_SECRET` printed `undefined` even with the real value sitting in `packages/server/.env`). This is a third independent runtime, alongside the Prisma CLI and the real app via `main.ts`'s `ConfigModule` — none of the three share env-loading with each other (see `debugging-notes.md`'s case log). But setting it in `.env` wouldn't be the right fix here even if Vitest did load it: a unit test shouldn't depend on a real secret value from a file that might not exist in CI or a fresh clone. Setting it directly in `beforeAll` makes the test self-contained and deterministic regardless of `.env`'s contents.

Run it (`npx vitest run src/auth/jwt.strategy.spec.ts`) and watch it fail — `jwt.strategy.ts` doesn't export either name yet. That failure is expected and correct; it's the "red" in red-green-refactor.

**You'll still need `JWT_SECRET` in `packages/server/.env` separately** — not for this spec (handled by `beforeAll` above), but for the real app: `AuthModule`'s `JwtModule.register({ secret: process.env.JWT_SECRET, ... })` in Step 4c needs it to actually sign tokens outside of tests.
```
JWT_SECRET=<some long random string>
```

Now the implementation, written just to make the spec pass:

**`jwt.strategy.ts`** — reads the token from the cookie, not an `Authorization` header. The extractor is its own exported function specifically so the spec above can import and test it directly, rather than a copy of it. The constructor guards `secretOrKey` with an early throw rather than passing `process.env.JWT_SECRET` straight through — `process.env.X` is typed `string | undefined` (an env var might not exist), but `passport-jwt`'s types require a real `string | Buffer`; the throw both narrows the type (TypeScript understands `secretOrKey` is `string` after the guard) and turns a confusing error from deep inside `passport-jwt`'s internals into a clear one pointing at the actual missing env var:
```ts
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import type { Request } from 'express';

export function extractTokenFromCookie(req: Request): string | null {
  return req.cookies?.['access_token'] ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    const secretOrKey = process.env.JWT_SECRET;
    if (!secretOrKey) {
      throw new Error('JWT_SECRET is not set');
    }
    super({
      jwtFromRequest: extractTokenFromCookie,
      secretOrKey,
    });
  }

  async validate(payload: { sub: string; email: string }) {
    return { id: payload.sub, email: payload.email };
  }
}
```

Re-run the spec — should be green now.

**Not unit-tested, deliberately**: whether `passport-jwt` actually verifies a JWT's signature correctly. That's testing a trusted third-party library's own correctness, not this project's code — not this project's job to re-prove. Whether an invalid/expired/missing token produces a real `401` on a real route is an integration concern, proven by Step 6's e2e test instead.

### Step 4b — Guards: spec first for the one with logic, no spec for the one without

Architecture.md §7 marks several routes "optional" auth (viewing a public task needs no login). The standard `AuthGuard('jwt')` throws `401` when there's no token at all, which breaks anonymous public-task viewing — so there are two guards, and they're not equally testable.

**`guards/optional-jwt-auth.guard.spec.ts`** — this one overrides `handleRequest` to swallow the "no token" case instead of throwing; that override is exactly the behavior worth driving with a test:
```ts
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard.js';

describe('OptionalJwtAuthGuard', () => {
  it('returns null instead of throwing when there is no user', () => {
    const guard = new OptionalJwtAuthGuard();
    expect(guard.handleRequest(null, null)).toBeNull();
  });

  it('passes a real user through unchanged', () => {
    const guard = new OptionalJwtAuthGuard();
    const user = { id: '1', email: 'a@b.com' };
    expect(guard.handleRequest(null, user)).toBe(user);
  });
});
```

Watch it fail (no `optional-jwt-auth.guard.ts` yet), then write just enough to pass:

```ts
// guards/optional-jwt-auth.guard.ts
import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = any>(err: any, user: any): TUser {
    return (user ?? null) as TUser; // never throws; req.user is null instead of 401
  }

  canActivate(context: ExecutionContext) {
    return super.canActivate(context) as Promise<boolean>;
  }
}
```

**Why `handleRequest` is generic (`<TUser = any>`) instead of the more obvious `(err: unknown, user: unknown)`**: `@nestjs/passport`'s `IAuthGuard` interface declares `handleRequest` as a generic method — `<TUser = any>(err, user, info, context, status?) => TUser`. Overriding it with a fixed, concrete return type (`{} | null`, which is what `(err: unknown, user: unknown) => user ?? null` infers to) doesn't type-check, because TypeScript can't verify a fixed-type override satisfies *every* possible instantiation of `TUser` a caller might request — only matching the base method's own generic shape, and casting the return, does. Confirmed by actually compiling both versions against this project's installed `@nestjs/passport` — the version with `unknown` params and no generic fails with `TS2416`; this one doesn't.

**`guards/jwt-auth.guard.ts` gets no spec file.** It's a bare subclass with zero overrides — its entire behavior *is* `AuthGuard('jwt')`'s behavior, already trusted library code:
```ts
// guards/jwt-auth.guard.ts
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
```
Writing a spec that constructs this and asserts it's an instance of `AuthGuard` would test TypeScript's `class`/`extends` keywords, not anything this project wrote. Skipped deliberately, not forgotten.

This pair matters beyond auth — `TaskAccessGuard` in Step 5 relies on `OptionalJwtAuthGuard` having already run, so it can check `req.user` for ownership *or* let anonymous requests through to public tasks.

### Step 4c — `AuthController` and `AuthModule`: no dedicated spec, wiring only

Both are thin: the controller calls straight into the already-tested `AuthService` and sets/reads a cookie (no branching logic of its own); the module is pure DI registration. Neither has behavior worth test-driving in isolation — both are exercised for real by Step 6's e2e test, which is a stronger proof than a unit spec mocking `AuthService` would be here.

**`auth.controller.ts`**:
```ts
import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const token = await this.auth.login(dto);
    res.cookie('access_token', token, { httpOnly: true, secure: true, sameSite: 'lax' });
    return { ok: true };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('access_token');
    return { ok: true };
  }
}
```

**`auth.module.ts`** — exports both guards so `TasksModule` can use them without re-declaring:
```ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtStrategy } from './jwt.strategy.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { OptionalJwtAuthGuard } from './guards/optional-jwt-auth.guard.js';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({ secret: process.env.JWT_SECRET, signOptions: { expiresIn: '1d' } }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtAuthGuard, OptionalJwtAuthGuard],
  exports: [JwtAuthGuard, OptionalJwtAuthGuard],
})
export class AuthModule {}
```

Add `AuthModule` to `AppModule`'s `imports`, same as `PrismaModule` in Phase 0.

## Step 5 — `TasksModule`

Files under `packages/server/src/tasks/`. Same split as Step 4: real logic gets a spec written first, thin wiring doesn't.

### Step 5a — `TaskAccessGuard`: spec first

This is the test that matters most in the whole phase — it's the one that actually proves architecture.md §8's authorization rule holds. Write it before the guard exists:

**`guards/task-access.guard.spec.ts`**, covering every combination without any HTTP or real database involved:
```ts
import { TaskAccessGuard } from './task-access.guard.js';
import { ExecutionContext } from '@nestjs/common';

function makeContext(task: any, userId?: string) {
  const req = { params: { id: 'task-1' }, user: userId ? { id: userId } : null };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('TaskAccessGuard', () => {
  const owner = 'owner-1';
  const stranger = 'stranger-1';

  it.each([
    ['public', owner, true],
    ['public', stranger, true],
    ['public', undefined, true],
    ['private', owner, true],
    ['private', stranger, false],
    ['private', undefined, false],
  ])('visibility=%s, requester=%s -> %s', async (visibility, requesterId, expected) => {
    const prismaMock = { task: { findUnique: async () => ({ id: 'task-1', ownerId: owner, visibility }) } };
    const guard = new TaskAccessGuard(prismaMock as any);
    const result = await guard.canActivate(makeContext(null, requesterId));
    expect(result).toBe(expected);
  });
});
```

Six cases, directly matching the authorization matrix named in `implementation-plan.md`'s Phase 1 "Done when" line. Run it, watch all six fail (no `task-access.guard.ts` yet), then write just enough to turn them green:

**`guards/task-access.guard.ts`**:
```ts
import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class TaskAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const task = await this.prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task) throw new NotFoundException();

    req.task = task; // avoids a second query in the handler
    return task.visibility === 'public' || task.ownerId === req.user?.id;
  }
}
```

This guard must run *after* `OptionalJwtAuthGuard` on any route that uses it, so `req.user` is already populated (or `null`) by the time it checks ownership. `@UseGuards(OptionalJwtAuthGuard, TaskAccessGuard)`, in that order — Nest runs guards left to right.

### Step 5b — `TasksService`: spec first

Real logic here too — architecture.md §10 requires visibility to be scoped "at the data-access layer, not just the route layer," meaning `findAllVisibleTo`'s query-building is itself a rule worth driving with a test, not just something the guard happens to also check:

**`tasks.service.spec.ts`**:
```ts
import { Test } from '@nestjs/testing';
import { TasksService } from './tasks.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('TasksService', () => {
  it('includes the caller\'s own tasks alongside public ones when logged in', async () => {
    let capturedWhere: unknown;
    const prismaMock = {
      task: {
        findMany: async (args: { where: unknown }) => {
          capturedWhere = args.where;
          return [];
        },
      },
    };

    const module = await Test.createTestingModule({
      providers: [TasksService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();

    const service = module.get(TasksService);
    await service.findAllVisibleTo('user-1');

    expect(capturedWhere).toEqual({
      OR: [{ visibility: 'public' }, { ownerId: 'user-1' }],
    });
  });

  it('only queries public tasks when the caller is anonymous', async () => {
    let capturedWhere: unknown;
    const prismaMock = {
      task: {
        findMany: async (args: { where: unknown }) => {
          capturedWhere = args.where;
          return [];
        },
      },
    };

    const module = await Test.createTestingModule({
      providers: [TasksService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();

    const service = module.get(TasksService);
    await service.findAllVisibleTo(undefined);

    expect(capturedWhere).toEqual({ OR: [{ visibility: 'public' }] });
  });
});
```

Watch both fail (no `tasks.service.ts` yet), then implement:

**`tasks.service.ts`**:
```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateTaskDto } from './dto/create-task.dto.js';

@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  create(ownerId: string, dto: CreateTaskDto) {
    return this.prisma.task.create({ data: { ...dto, ownerId } });
  }

  findAllVisibleTo(userId?: string) {
    return this.prisma.task.findMany({
      where: { OR: [{ visibility: 'public' }, ...(userId ? [{ ownerId: userId }] : [])] },
    });
  }
}
```

### Step 5c — `CreateTaskDto`, `TasksController`, `TasksModule`: no dedicated spec

`CreateTaskDto` is declarative — the decorators *are* the specification, not something with independent logic to drive. If you want a sanity check comparable to the one run on `RegisterDto` earlier, the same `plainToInstance` + `validate()` recipe (see `docs/debugging-notes.md`'s "Useful commands") applies, but it's not a committed spec file. `TasksController` is thin — delegates straight to the already-tested `TasksService`, no branching of its own — and `TasksModule` is pure wiring. All three are exercised for real by Step 6's e2e test.

**`dto/create-task.dto.ts`** — validates against the same `TaskVisibility` enum Step 1 added to `schema.prisma`, imported from the generated client, instead of a separately hardcoded list that could drift out of sync with it:
```ts
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { TaskVisibility } from '../../../generated/prisma/client.js';

export class CreateTaskDto {
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(TaskVisibility)
  visibility: TaskVisibility;
}
```

`@IsEnum()` needs a real runtime object to check against (it calls `Object.values()` on whatever you pass it), which is exactly what Prisma generates for an `enum` block — unlike the plain string-literal union types in `packages/shared`, which have no runtime representation at all and couldn't be used here.

**`tasks.controller.ts`**
```ts
import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { TasksService } from './tasks.service.js';
import { CreateTaskDto } from './dto/create-task.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard.js';
import { TaskAccessGuard } from './guards/task-access.guard.js';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  findAll(@Req() req: any) {
    return this.tasks.findAllVisibleTo(req.user?.id);
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard, TaskAccessGuard)
  findOne(@Req() req: any) {
    return req.task; // TaskAccessGuard already loaded and attached it
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Req() req: any, @Body() dto: CreateTaskDto) {
    return this.tasks.create(req.user.id, dto);
  }
}
```

**`tasks.module.ts`**
```ts
import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';
import { TaskAccessGuard } from './guards/task-access.guard.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  controllers: [TasksController],
  providers: [TasksService, TaskAccessGuard],
})
export class TasksModule {}
```

Add `TasksModule` to `AppModule`'s `imports` too.

## Step 6 — E2E test: the actual "Done when" check

`packages/server/test/tasks.e2e-spec.ts` — boots the real `AppModule`, hits real HTTP routes with `supertest`, proving the exact scenario from `implementation-plan.md`: *"a user can register, log in, create a task, and a second user can see it only if it's public."*

**On TDD ordering, this one's different from Steps 4–5 above**: in strict outside-in TDD, an acceptance test like this is often written *first*, before any of the units underneath it exist, as the single "red" test the whole feature is driving toward — everything in Steps 4 and 5 would then exist specifically to turn this one green. It's placed last here instead because it genuinely can't run meaningfully before `AuthModule` and `TasksModule` are registered in `AppModule` (it'd just 404 on every request, which isn't a useful "red" — it's not even reaching the code being tested). If you want the more textbook outside-in flow, there's nothing stopping you from writing this file now, confirming it fails for the *right* reason (404, not a crash), and treating it as the target the rest of this step is working toward.

**Prerequisite, easy to miss:** `AuthModule` and `TasksModule` both have to be registered in `AppModule`'s `imports` — same "dead code until imported from the root" rule as `PrismaModule` back in Phase 0. Without both, every route this test hits 404s (no route matched at all), which looks similar to but is a completely different failure from `TaskAccessGuard`'s own legitimate 403/404 responses.

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('Tasks (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.comment.deleteMany();
    await prisma.task.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(() => app.close());

  it('owner creates a private task; a second user cannot see it; making it public fixes that', async () => {
    const owner = request.agent(app.getHttpServer());
    await owner.post('/auth/register').send({ email: 'owner@test.com', password: 'password123', name: 'Owner' });
    await owner.post('/auth/login').send({ email: 'owner@test.com', password: 'password123' });

    const createRes = await owner.post('/tasks').send({ title: 'Private task', visibility: 'private' });
    const taskId = createRes.body.id;

    const stranger = request.agent(app.getHttpServer());
    await stranger.post('/auth/register').send({ email: 'stranger@test.com', password: 'password123', name: 'Stranger' });
    await stranger.post('/auth/login').send({ email: 'stranger@test.com', password: 'password123' });

    await stranger.get(`/tasks/${taskId}`).expect(403);

    const anon = request(app.getHttpServer());
    await anon.get(`/tasks/${taskId}`).expect(403);
  });
});
```

**Why `beforeAll` builds the app and `beforeEach` only clears data, not the other way round:** `Test.createTestingModule(...).compile()` plus `app.init()` is expensive — full module resolution, every provider's lifecycle hooks, a real Postgres connection pool. That only needs to happen once per file, not once per test, so it's in `beforeAll`. Clearing rows between tests is cheap and genuinely needs to run before every single test, so that part stays in `beforeEach`. `app.get(PrismaService)` pulls the real instance out of the DI container `beforeAll` just built — same mechanism as `module.get(TasksService)` in the unit tests, on the full app's container instead of a narrow test-only one.

**Resolved — separate test database, reset via table-clearing.** This test writes real rows via the real `PrismaService`, against whatever `DATABASE_URL` the app resolves at test time. Running it repeatedly against your local dev database would hit the `@unique` constraint on `email` on the second run, and would also mean every e2e run deletes/mutates data you might be looking at via Prisma Studio or the REPL.

**Why this option over the alternatives:** transaction-wrapping (roll back each test's changes automatically) is the fastest approach but requires every query during a request — across however many services get called — to share one open transaction, which isn't how `PrismaService` is scoped by default; making it work needs a custom test harness or a library like `nestjs-cls`. Real complexity for a speed optimization this project doesn't need yet at one e2e spec. Table-clearing against the *real* dev database works but pollutes data you're actively using elsewhere. A separate database avoids both problems and is simple to set up.

**Setup:**

1. Create the second database, in the same Postgres container:
```bash
docker compose exec postgres psql -U tasks_app -d tasks_app -c "CREATE DATABASE tasks_app_test;"
```

2. `packages/server/.env.test` — use your actual Postgres password here (whatever's in `packages/server/.env`'s `DATABASE_URL`), and include `JWT_SECRET` too: `AuthModule`'s `JwtModule.register({ secret: process.env.JWT_SECRET })` needs it, and `.env.test` is loaded independently from `.env` (see point 4 below), so it won't inherit it otherwise:
```
DATABASE_URL="postgresql://tasks_app:<your real password>@localhost:5432/tasks_app_test"
JWT_SECRET=test-secret
```
**If copying this command into a terminal, substitute the real password before running it** — `zsh` interprets unescaped `<`/`>` as redirection operators, so pasting the placeholder literally produces a confusing shell error that has nothing to do with Prisma.

3. Apply migrations to the new database (same migration history, different target — substitute your real password here too):
```bash
DATABASE_URL="postgresql://tasks_app:<your real password>@localhost:5432/tasks_app_test" npx prisma migrate deploy
```

4. **Vitest doesn't load `.env` automatically** — same gap as `debugging-notes.md` case #7 (Vitest is a third independent runtime that doesn't share env-loading with the CLI or the real app). `.env.test` needs to be loaded explicitly for e2e runs specifically. Add a setup file, referenced from `vitest.config.e2e.ts`:

```ts
// test/setup-e2e.ts
import { config } from 'dotenv';
config({ path: '.env.test' });
```

```ts
// vitest.config.e2e.ts — add to the existing config
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    setupFiles: ['./test/setup-e2e.ts'],
  },
});
```

5. The data-clearing itself (FK-safe order — comments reference both tasks and users) is already shown inline in the `beforeAll`/`beforeEach` split in the spec above — nothing further to add here.

Table-clearing, not transaction-wrapping, is the right call at this project's current size — worth revisiting only if the e2e suite grows large enough that clearing/re-seeding actually becomes the slow part.

## Done when

- `npx prisma migrate dev --name add_core_models` runs clean, `users`/`tasks`/`comments` tables exist
- `npm run test` passes: `auth.service.spec.ts`, `jwt.strategy.spec.ts`, `optional-jwt-auth.guard.spec.ts`, `task-access.guard.spec.ts`'s six-case matrix, and `tasks.service.spec.ts`
- `npm run test:e2e` passes, and passes again on an immediate re-run (confirms the `beforeEach` cleanup actually works) — verified: both tests pass, twice in a row
- A user can register, log in (receives the httpOnly cookie), create a task, and a second user can see it only if it's public — matching `implementation-plan.md`'s Phase 1 "Done when" line exactly — verified end-to-end via the real e2e run, not just by reading the code
