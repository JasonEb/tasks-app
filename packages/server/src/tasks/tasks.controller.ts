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
    @UseGuards(OptionalJwtAuthGuard, TaskAccessGuard)
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