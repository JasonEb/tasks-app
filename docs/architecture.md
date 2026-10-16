# Architecture

## 1. Overview

A task management app where users create tasks, mark them public or private, and discuss them through comments. Comments on public tasks appear live to everyone currently viewing that task, without a page refresh.

**Core requirement driving the design:** real-time comment delivery to multiple concurrent viewers of a public task. Postgres remains the single source of truth for tasks/comments/users; Redis is added specifically as the real-time fan-out layer (pub/sub) between Node instances — a deliberate choice to practice the standard enterprise pattern for scaling WebSocket servers horizontally, not a load requirement v1 actually has yet.

## 2. Assumptions

These shape the design below. Flag any that don't match intent:

- Viewing a public task requires no authentication; posting a comment does (comments are attributed to a user).
- "Public" vs "private" is a per-task flag set by the task's owner. Private tasks are visible only to their owner (no sharing/collaborators in v1).
- Single Postgres instance (no read replicas) for v1. The app may run multiple Node instances behind a load balancer.
- Web client only for v1 (no native mobile), but the API is transport-agnostic enough to support one later.

## 3. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict mode) | end-to-end type safety, shared types between server/client |
| Runtime | Node.js (LTS) | required by the brief |
| HTTP framework | NestJS (Express adapter) | opinionated module/DI structure, built-in guards/pipes, and a first-party WebSocket gateway — all three things this app needs anyway |
| Validation | class-validator + class-transformer | Nest's idiomatic DTO validation, wired through `ValidationPipe` |
| Database | PostgreSQL | required by the brief |
| ORM/Query builder | Prisma | migrations, type-safe queries, good DX with Postgres; wrapped in a Nest `PrismaService` |
| Real-time transport | Socket.IO via `@nestjs/websockets` + `@nestjs/platform-socket.io` | room-based broadcast model maps cleanly to "per-task" subscriptions; Nest's `WebSocketGateway` keeps it in the same DI graph (and the same guards) as the REST layer |
| Real-time fan-out across instances | Redis (pub/sub) via `@socket.io/redis-adapter` + `ioredis` | the standard way to scale Socket.IO horizontally; decouples the WebSocket layer from the database (see §6) |
| Distributed rate limiting | Redis-backed store for `@nestjs/throttler` | an in-memory counter per Node instance would let a client bypass limits by hitting a different instance; Redis makes the limit global |
| Auth | JWT access token in an httpOnly cookie, issued via `@nestjs/jwt` and verified by a `passport-jwt` strategy (`@nestjs/passport`) | stateless, works for both HTTP and WebSocket handshake |
| Frontend | React + Vite | simple, fast dev loop; not the focus of this plan but needed to demo real-time behavior |

## 4. System Components

```
                    ┌─────────────┐
                    │   Browser    │
                    │ (React app)  │
                    └──────┬───────┘
                HTTP  ▲    │    ▲  WebSocket
                      │    │    │
              ┌───────┴────┴────┴────────┐
              │     Load Balancer         │
              └───────────┬───────────────┘
                 ┌─────────┴─────────┐
                 │                   │
          ┌──────┴──────┐     ┌──────┴──────┐
          │ Node Instance│     │ Node Instance│   (horizontally scalable)
          │  NestJS      │     │  NestJS      │
          │  Socket.IO   │     │  Socket.IO   │
          └──────┬──┬────┘     └────┬──┬──────┘
                 │  │  pub/sub      │  │
                 │  └───────┬───────┘  │
                 │     ┌────┴────┐     │
                 │     │  Redis   │    │
                 │     │ pub/sub  │    │
                 │     └─────────┘     │
                 │                     │
                 └──────────┬──────────┘
                      SQL reads/writes
                    ┌──────┴───────┐
                    │  PostgreSQL   │
                    │ tasks, users, │
                    │ comments      │
                    └───────────────┘
```

Each Node instance serves REST traffic and holds its own set of WebSocket connections. No instance is a special "real-time server" — every instance both writes comments and broadcasts them. Redis carries only the live fan-out signal between instances; it holds no durable data — Postgres is still the only system of record.

## 5. Data Model

```
users
  id            uuid PK
  email         text unique not null
  password_hash text not null
  name          text not null
  created_at    timestamptz not null default now()

tasks
  id          uuid PK
  owner_id    uuid FK -> users.id
  title       text not null
  description text
  status      text not null check (status in ('todo','in_progress','done'))
  visibility  text not null check (visibility in ('public','private')) default 'private'
  created_at  timestamptz not null default now()
  updated_at  timestamptz not null default now()

comments
  id          uuid PK
  task_id     uuid FK -> tasks.id on delete cascade
  author_id   uuid FK -> users.id
  body        text not null
  created_at  timestamptz not null default now()
```

Indexes: `tasks(owner_id)`, `tasks(visibility)`, `comments(task_id, created_at)`.

## 6. Real-Time Design

### 6.1 Why Redis pub/sub

Socket.IO rooms are per-instance by default: a client connected to instance A never sees a `server.to(room).emit(...)` call made on instance B. The official fix is the [Socket.IO Redis adapter](https://socket.io/docs/v4/redis-adapter/) — it replaces the default in-memory adapter with one that publishes every emit to a Redis pub/sub channel, which every other instance is subscribed to and re-emits locally. This is the pattern most production Socket.IO deployments use, which is exactly why it's worth practicing here even though v1's traffic doesn't strictly need it yet.

- Two `ioredis` clients are required: one for publishing, one for subscribing (a Redis connection in subscribe mode can't issue other commands). Both are created once in a `RedisModule` and injected wherever needed.
- Wiring: a custom `IoAdapter` subclass (`RedisIoAdapter`) is set on the Nest app in `main.ts` via `app.useWebSocketAdapter(new RedisIoAdapter(app))`, *before* `app.listen()`. Nest's `WebSocketGateway` then runs on top of it transparently — gateway code doesn't know Redis exists.
- This replaces the manual "listen, fetch, re-emit" bridge a Postgres-`NOTIFY`-based design would need: application code just calls `server.to('task:{taskId}').emit('comment:new', comment)` once, on whichever instance handled the write, and the adapter guarantees every instance's local room members receive it.

**Trade-off accepted:** Redis pub/sub is fire-and-forget — if an instance is briefly down or a client is mid-reconnect when a message is published, that message is gone; there's no replay. For this app that's acceptable because the REST `GET /tasks/:id/comments` endpoint is the durable source of truth (Postgres) and a reconnecting client always re-fetches it, so a missed live event only means a brief delay, not lost data. If guaranteed delivery or replay-on-reconnect becomes a requirement, Redis Streams (consumer groups, `XADD`/`XREADGROUP`) is the natural upgrade and is worth a follow-up iteration for the same reason Redis itself is: it's a step more advanced and a step more representative of enterprise event-streaming systems.

### 6.2 Comment write + broadcast flow

1. Client `POST /tasks/:id/comments` with `{ body }`.
2. Server validates the requester can see the task (public, or owner for private), inserts the row via Prisma, and calls `server.to('task:{taskId}').emit('comment:new', comment)` on the gateway's Socket.IO server instance.
3. The Redis adapter publishes that emit to a Redis channel. Every Node instance (including the originating one) is subscribed and re-emits to its own local `task:{taskId}` room members.
4. Each client receives exactly one `comment:new` event, regardless of which instance it's connected to or which instance handled the write.

### 6.3 Room access control

- On WebSocket connection, the client authenticates via the same JWT cookie used for HTTP (read during the Socket.IO handshake).
- `join task:{taskId}` is a server-validated action: the server checks task visibility/ownership before adding the socket to the room. An unauthenticated or unauthorized join is rejected with an error event, not a silent no-op.

## 7. API Design (REST)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | none | create account |
| POST | `/auth/login` | none | issue JWT cookie |
| POST | `/auth/logout` | session | clear cookie |
| GET | `/tasks` | optional | list caller's tasks + public tasks |
| POST | `/tasks` | required | create task |
| GET | `/tasks/:id` | optional | fetch one task (403 if private and not owner) |
| PATCH | `/tasks/:id` | owner | update task |
| DELETE | `/tasks/:id` | owner | delete task |
| GET | `/tasks/:id/comments` | optional | paginated comment history |
| POST | `/tasks/:id/comments` | required | create comment (triggers broadcast) |

WebSocket events: `join:task`, `leave:task`, `comment:new` (server→client), `error`.

## 8. Authorization Rules

- A task is readable if `visibility = 'public'` OR `owner_id = currentUser.id`.
- A task is writable (edit/delete) only by its owner.
- A comment can be created on a task the caller can read; it cannot be edited or deleted in v1.
- The same read rule gates both the REST `GET` and the WebSocket room join. It's implemented once, as a `TaskAccessGuard`, and reused as a Nest `CanActivate` guard on the REST controller *and* on the gateway's `join:task` handler — one implementation, so the two can't drift apart.

## 9. Project Structure (proposed)

```
tasks-app/
  packages/
    server/                  # NestJS + Socket.IO + Prisma
      src/
        app.module.ts
        main.ts
        auth/
          auth.module.ts
          auth.controller.ts
          auth.service.ts
          jwt.strategy.ts
        tasks/
          tasks.module.ts
          tasks.controller.ts
          tasks.service.ts
          dto/
          guards/
            task-access.guard.ts   # shared by comments module + realtime gateway
        comments/
          comments.module.ts
          comments.controller.ts
          comments.service.ts
          dto/
        realtime/
          realtime.module.ts
          comments.gateway.ts      # @WebSocketGateway; join/leave + broadcast
          redis-io.adapter.ts      # custom IoAdapter wiring the Redis adapter
        redis/
          redis.module.ts
          redis.providers.ts       # pub/sub ioredis clients, DI tokens
        prisma/
          prisma.module.ts
          prisma.service.ts        # OnModuleInit/OnModuleDestroy lifecycle
    web/                      # React + Vite client
    shared/                   # TS types/interfaces shared by server and web
  docs/
    architecture.md
    implementation-plan.md
```

Each top-level folder under `src/` is a Nest module (`AuthModule`, `TasksModule`, `CommentsModule`, `RealtimeModule`, `RedisModule`, `PrismaModule`), imported into `AppModule`. A pnpm/npm workspace monorepo wraps the whole thing so `shared` types are imported directly by both `server` and `web` without publishing a package; the Nest CLI (`nest g module/controller/service`) is still used for scaffolding inside `packages/server`.

## 10. Security Considerations

- Passwords hashed with bcrypt/argon2, never logged.
- JWT in httpOnly, `Secure`, `SameSite=Lax` cookie — not accessible to client JS, mitigates XSS token theft.
- Rate limit comment creation per user via `@nestjs/throttler` with a Redis storage backend, so the limit holds across instances (see §3) and can't be bypassed by hitting a different one.
- All task/comment queries scoped by the authorization rule in §8 at the data-access layer, not just the route layer, so a missed check in one route can't leak private tasks.
- Input validation (`class-validator` DTOs + `ValidationPipe`) on every request body before it reaches Prisma.
- Redis requires a password (`requirepass`) even in local dev, and TLS + auth for any managed/hosted instance in production — an open Redis pub/sub channel is a way to both snoop on and forge live comment events.
