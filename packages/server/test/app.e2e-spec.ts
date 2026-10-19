import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;
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

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

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
