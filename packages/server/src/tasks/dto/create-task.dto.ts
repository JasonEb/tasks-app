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