# Phase 1 — Data Layer & Core Task API

Follow in order from `packages/server` unless noted. See [architecture.md](./architecture.md) §5 (data model), §7 (API), §8 (authorization) for the design this implements.

## Where the tests are

`implementation-plan.md`'s Phase 1 listed tests as a single bullet at the end, naming Jest — that's wrong for this project (confirmed: the `nest new` scaffold uses **Vitest**, not Jest). Fixed in that file. More importantly, "one bullet at the end" undersells it — this phase actually has three separate testing moments, placed where they belong instead of batched at the end:

1. **Step 4b** — a unit spec for `TaskAccessGuard`'s pure logic (no HTTP, no real DB), right after the guard is written.
2. **Step 3b** — a unit spec for `AuthService`'s register/login logic, right after that service is written.
3. **Step 5** — an e2e spec hitting real HTTP routes with `supertest`, once there's an actual end-to-end flow (register → login → create task → second user reads it) to exercise. This is the one that proves Phase 1's actual "Done when" criterion.

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

Files, all under `packages/server/src/auth/`:

**`dto/register.dto.ts`**
```ts
import { IsEmail, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  name: string;
}
```

**`dto/login.dto.ts`**
```ts
import { IsEmail, IsString } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}
```

**`auth.service.ts`** — register hashes the password and creates the user; login verifies it and signs a JWT:
```ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const passwordHash = await bcrypt.hash(dto.password, 10);
    return this.prisma.user.create({
      data: { email: dto.email, passwordHash, name: dto.name },
    });
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.jwt.signAsync({ sub: user.id, email: user.email });
  }
}
```

**`jwt.strategy.ts`** — reads the token from the cookie, not an `Authorization` header:
```ts
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import type { Request } from 'express';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: (req: Request) => req.cookies?.['access_token'] ?? null,
      secretOrKey: process.env.JWT_SECRET,
    });
  }

  async validate(payload: { sub: string; email: string }) {
    return { id: payload.sub, email: payload.email };
  }
}
```

**`guards/jwt-auth.guard.ts`** and **`guards/optional-jwt-auth.guard.ts`** — two guards, not one. Architecture.md §7 marks several routes "optional" auth (viewing a public task needs no login). The standard `AuthGuard('jwt')` throws `401` when there's no token at all, which breaks anonymous public-task viewing. The fix is a second guard that attempts auth but never rejects:

```ts
// guards/jwt-auth.guard.ts
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
```

```ts
// guards/optional-jwt-auth.guard.ts
import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err: unknown, user: unknown) {
    return user ?? null; // never throws; req.user is null instead of 401
  }

  canActivate(context: ExecutionContext) {
    return super.canActivate(context) as Promise<boolean>;
  }
}
```

This pair matters beyond auth — `TaskAccessGuard` in Step 5 relies on `OptionalJwtAuthGuard` having already run, so it can check `req.user` for ownership *or* let anonymous requests through to public tasks.

**`auth.controller.ts`** — sets/clears the httpOnly cookie:
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

Add `AuthModule` to `AppModule`'s `imports`, same as `PrismaModule` in Phase 0. Also add `JWT_SECRET=<some long random string>` to `packages/server/.env`.

### Step 4b — Unit test: `auth.service.spec.ts`

Colocated at `packages/server/src/auth/auth.service.spec.ts`. Mock `PrismaService` and `JwtService` — this test has no business touching a real database:

```ts
import { Test } from '@nestjs/testing';
import { AuthService } from './auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { JwtService } from '@nestjs/jwt';

describe('AuthService', () => {
  it('rejects login with wrong password', async () => {
    const prismaMock = {
      user: { findUnique: async () => ({ id: '1', email: 'a@b.com', passwordHash: await (await import('bcrypt')).hash('correct', 10) }) },
    };
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: JwtService, useValue: { signAsync: async () => 'token' } },
      ],
    }).compile();

    const service = module.get(AuthService);
    await expect(service.login({ email: 'a@b.com', password: 'wrong' })).rejects.toThrow();
  });
});
```

## Step 5 — `TasksModule`

Files under `packages/server/src/tasks/`:

**`dto/create-task.dto.ts`** — validates against the same `TaskVisibility` enum Step 1 added to `schema.prisma`, imported from the generated client, instead of a separately hardcoded list that could drift out of sync with it:
```ts
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { TaskVisibility } from '../../generated/prisma/client.js';

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

**`guards/task-access.guard.ts`** — architecture.md §8's rule, implemented once:
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

### Step 5b — Unit test: `task-access.guard.spec.ts`

This is the test that matters most for proving §8's rule actually holds. Colocated at `packages/server/src/tasks/guards/task-access.guard.spec.ts`, covering all combinations without any HTTP or real database involved:

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

Six cases, directly matching the authorization matrix named in `implementation-plan.md`'s Phase 1 "Done when" line and Phase 1's test bullet ("owner vs stranger vs anonymous, public vs private").

**`tasks.service.ts`** — note the query itself is scoped, not just the guard (architecture.md §10: "scoped... at the data-access layer, not just the route layer"):
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

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module.js';

describe('Tasks (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    await app.init();
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

**Open decision before this runs cleanly in CI or repeatedly locally:** this test writes real rows via the real `PrismaService`, against whatever `DATABASE_URL` the app resolves at test time — currently that's your local dev database. Running it repeatedly will hit the `@unique` constraint on `email` on the second run. Pick one before writing more e2e tests:
- A separate `tasks_app_test` database (new Postgres DB in the same container, distinct `DATABASE_URL` sourced from a `.env.test`), reset between runs.
- Wrapping each test in a transaction that's rolled back afterward.
- Clearing relevant tables in an `afterEach`.

Not resolved here — flagging it the same way `implementation-plan.md`'s "Open Decisions" section flags unresolved calls, since it'll block Step 6 from being runnable more than once without a crash.

## Done when

- `npx prisma migrate dev --name add_core_models` runs clean, `users`/`tasks`/`comments` tables exist
- `npm run test` passes, including `task-access.guard.spec.ts`'s six-case matrix and `auth.service.spec.ts`
- `npm run test:e2e` passes once the test-database decision above is resolved
- A user can register, log in (receives the httpOnly cookie), create a task, and a second user can see it only if it's public — matching `implementation-plan.md`'s Phase 1 "Done when" line exactly
