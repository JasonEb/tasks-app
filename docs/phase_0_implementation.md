# Phase 0 — Remaining Steps: PrismaService Wiring

Follow these in order from the repo root unless a step says otherwise. Each one builds on the last.

## Step 0 — Prerequisite: initialize the Prisma schema file

`packages/server/prisma/schema.prisma` doesn't exist yet — only `prisma`/`@prisma/client` are installed and `DATABASE_URL` is already set in `packages/server/.env`. Without a schema file, nothing below will run.

```bash
cd packages/server
npx prisma init --datasource-provider postgresql
```

**This project is on Prisma 7, which changed `init`'s output from older versions.** What it actually generates now:

- `prisma/schema.prisma` — `datasource db` has **no `url`** in it anymore. Connection config moved out of the schema file.
- `prisma7.config.ts` — this is where the URL actually lives: `datasource: { url: process.env["DATABASE_URL"] }`. The CLI auto-discovers this file (confirmed via its own `Loaded Prisma config from prisma7.config.ts` log line) — no `--config` flag needed.
- The `generator client` block uses `provider = "prisma-client"` (not the old `prisma-client-js`) with `output = "../generated/prisma"` — the client generates as real files into `packages/server/generated/prisma/`, not into `node_modules/@prisma/client`. This changes the import in Step 1 below.
- It also appends `/generated/prisma` to a **local** `packages/server/.gitignore` it creates (redundant with the root `.gitignore`'s `.env`/`node_modules` lines, but harmless).
- It installs "skills" — instruction files for AI coding agents (`.claude/skills/`, `.windsurf/skills/`, `.agents/skills/`, tracked in `skills-lock.json`) — unrelated to this app, just Prisma's own CLI behavior now.
- It detects your existing `DATABASE_URL` in `.env` and does **not** duplicate it (confirmed: `warn Prisma would have added DATABASE_URL but it already exists in .env.`) — no cleanup needed this time.

## Step 1 — `PrismaService`

Create `packages/server/src/prisma/prisma.service.ts`:

```ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

**Import path note:** with the classic Prisma client generator, this would be `import { PrismaClient } from '@prisma/client'`. Because `schema.prisma`'s generator now outputs to `../generated/prisma` (see Step 0), `PrismaClient` has to be imported from that generated location instead. Verified directly — ran `npx prisma generate` and checked `generated/prisma/client.ts`, which exports `PrismaClient` by name, so the only change from the classic setup is the import path.

`onModuleInit` connects when Nest boots this module; `onModuleDestroy` disconnects when Nest tears the app down (e.g. on `SIGTERM`) — without it, connections could leak on shutdown.

## Step 2 — `PrismaModule`

Create `packages/server/src/prisma/prisma.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

Note the `.js` extension on the import — this project's `tsconfig.json` uses `nodenext` module resolution, which requires it even though the source file is `.ts`.

`@Global()` matters: it means any other module in the app can inject `PrismaService` without listing `PrismaModule` in its own `imports` array. Without it, you'd have to add `imports: [PrismaModule]` to every feature module (`TasksModule`, `CommentsModule`, ...) individually.

## Step 3 — Register `PrismaModule` in `AppModule`

`packages/server/src/app.module.ts` currently looks like this:

```ts
import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

Change it to:

```ts
import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';

@Module({
  imports: [PrismaModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

## Step 4 — Verify the connection

With `schema.prisma` still at its `prisma init` default (no models defined), run:

```bash
npx prisma migrate dev --name init
```

This should:
- Connect to the Postgres container using `DATABASE_URL`
- Create a `prisma/migrations/<timestamp>_init/` folder with an (empty, or near-empty) `migration.sql`
- Create a `_prisma_migrations` tracking table in the database — and nothing else, since there are no models yet

If it hangs or errors on connection, check `docker compose ps` first — Postgres needs to actually be running for this to succeed.

(`generated/prisma/` may already exist on disk from the import-path check above — `npx prisma generate` was run once already to confirm `PrismaClient`'s export shape. `migrate dev` regenerates it automatically anyway, so this is a no-op, not an error.)

### Confirm it worked

Either:

```bash
npx prisma studio
```

and confirm it opens without error (it'll show no models/tables yet, which is expected — Prisma Studio just needs to reach the database), or connect directly:

```bash
docker compose exec postgres psql -U tasks_app -d tasks_app -c "\dt"
```

and confirm `_prisma_migrations` is listed.

## Done when

- `npx prisma migrate dev --name init` completes with no errors
- `AppModule` imports `PrismaModule` and the app still boots (`npm run start` or `npm run start:dev` in `packages/server`)
- No actual data models exist yet — that's intentionally deferred to Phase 1
