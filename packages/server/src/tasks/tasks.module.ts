import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service.js';
import { TasksController } from './tasks.controller.js';
import { TaskAccessGuard } from './guards/task-access.guard.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
    imports: [AuthModule],
    controllers: [TasksController],
    providers: [TasksService, TaskAccessGuard],
})

export class TasksModule {}