# Implementation Plan

Phased so each phase ends with something runnable and testable. See [architecture.md](./architecture.md) for the design decisions behind each step.

## Phase 0 — Project Setup

- [ ] `git init`, `.gitignore` (node_modules, .env, dist)
- [ ] npm/pnpm workspace with `packages/server`, `packages/web`, `packages/shared`
- [ ] `nest new` inside `packages/server`; install `@nestjs/websockets`, `@nestjs/platform-socket.io`, `@socket.io/redis-adapter`, `ioredis`, `@nestjs/jwt`, `@nestjs/passport`, `passport-jwt`, `@nestjs/config`, `@nestjs/throttler`, `class-validator`, `class-transformer`
- [ ] TypeScript configs (base `tsconfig.json` + per-package extends)
- [x] ESLint + Prettier shared config
- [ ] Docker Compose: `postgres` service + a named volume, `redis` service (`redis:7-alpine`, `--requirepass` set even locally)
- [ ] Prisma initialized in `packages/server`, connected to local Postgres, wrapped in a `PrismaService`

**Done when:** `docker compose up`, `prisma migrate dev` run clean, bare Nest app boots and responds to a health check.

## Phase 1 — Data Layer & Core Task API

- [ ] Prisma schema for `users`, `tasks`, `comments` (per architecture.md §5)
- [ ] First migration
- [ ] `shared` package: plain TS interfaces for Task, Comment, and request/response bodies
- [ ] `AuthModule`: register, login, logout controllers; `@nestjs/jwt` for issuing tokens, a `passport-jwt` strategy reading the JWT from the httpOnly cookie
- [ ] `TasksModule`: CRUD controller + service; authorization rule from architecture.md §8 implemented once as `TaskAccessGuard` (a Nest `CanActivate`), not duplicated per-route
- [ ] Integration tests (Nest's `@nestjs/testing` + Jest + supertest) for authorization edge cases (owner vs stranger vs anonymous, public vs private)

**Done when:** a user can register, log in, create a task, and a second user can see it only if it's public.

## Phase 2 — Comments API (no real-time yet)

- [ ] `CommentsModule`: `GET /tasks/:id/comments` (paginated), `POST /tasks/:id/comments`, DTOs validated via `ValidationPipe`
- [ ] Reuse `TaskAccessGuard` to gate both endpoints
- [ ] Rate limiting on comment creation (`@nestjs/throttler`, in-memory storage for now — switches to the Redis storage adapter once Redis exists in Phase 3)
- [ ] Tests: commenting on someone else's public task works; commenting on someone else's private task 403s

**Done when:** comments persist and are readable via REST, with no live updates yet — confirms the data layer is solid before adding real-time complexity.

## Phase 3 — Real-Time Layer

- [ ] `RedisModule`: two `ioredis` clients (pub, sub) created once, exported behind DI tokens
- [ ] `RedisIoAdapter` (extends Nest's `IoAdapter`): wraps `createAdapter(pubClient, subClient)` from `@socket.io/redis-adapter`; wired in `main.ts` via `app.useWebSocketAdapter(...)` before `app.listen()`
- [ ] `RealtimeModule` with `CommentsGateway` (`@WebSocketGateway`), running on the same Nest app/port as the REST API
- [ ] JWT auth on the Socket.IO handshake via a `WsJwtGuard` that reuses the same `passport-jwt` verify logic as the REST `AuthGuard`
- [ ] `@SubscribeMessage('join:task')` / `@SubscribeMessage('leave:task')` handlers that run `TaskAccessGuard` before adding the socket to `task:{taskId}`
- [ ] On comment creation: insert via Prisma, then `server.to('task:{taskId}').emit('comment:new', comment)` — the Redis adapter handles cross-instance delivery, no manual bridge code needed
- [ ] Manual multi-instance test: run two server instances on different ports against the same Redis + Postgres, confirm a comment posted via instance A's REST API appears on a client connected to instance B's WebSocket
- [ ] Confirm Redis auth: connecting without the password fails; both `ioredis` clients use it

**Done when:** two browser tabs, each connected to a (possibly different) server instance, both see a new comment on a public task appear without refreshing.

## Phase 4 — Frontend

- [ ] React + Vite app scaffold, Tailwind (or plain CSS, your call) for styling
- [ ] Auth pages: register/login
- [ ] Task list (mine + public), task detail view
- [ ] Comment thread component: initial load via REST, live updates via Socket.IO client, optimistic append on send
- [ ] Public task view reachable without login (read-only comment list; login prompt to post)

**Done when:** a logged-out visitor can open a public task's URL and watch comments arrive live as other users post them.

## Phase 5 — Hardening & Deploy Prep

- [ ] Structured logging (`nestjs-pino` or Nest's built-in `Logger`)
- [ ] Global exception filter (`@Catch()`) returning consistent JSON error shapes
- [ ] `@nestjs/config` with a validation schema (Joi or a class-validator env class) — fail fast on missing `DATABASE_URL`, `JWT_SECRET`, etc.
- [ ] Switch `@nestjs/throttler` to its Redis storage adapter so the rate limit is enforced globally, not per-instance
- [ ] Dockerfile for the server; confirm it runs against a non-local Postgres and Redis (e.g. managed instances)
- [ ] Basic CI: typecheck, lint, test on push
- [ ] Load-test the comment broadcast path (even a simple script) to confirm the Redis adapter delivers to all instances under expected concurrent-viewer counts before shipping

**Done when:** the app can be deployed to a single environment end-to-end and survives a restart of one Node instance without dropping the other instance's connections.

## Open Decisions to Confirm Before Starting

- Hosting target (affects Phase 5 specifics): a single VM/container host, or a PaaS like Render/Fly.io?
- Is task editing/deletion by non-owners (e.g. shared collaborators) needed for v1, or is owner-only sufficient as scoped in architecture.md?
- Should comments be editable/deletable in v1, or append-only as currently planned?
- Stretch goal, not scoped into a phase above: replacing Redis pub/sub with Redis Streams (consumer groups, `XADD`/`XREADGROUP`) for at-least-once delivery and replay-on-reconnect — a reasonable "Phase 6" if you want to practice that pattern too (see architecture.md §6.1).
