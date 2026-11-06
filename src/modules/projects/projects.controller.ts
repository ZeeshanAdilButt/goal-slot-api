import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedRequest } from '../../shared/types/authenticated-request.interface';
import { ProjectsService } from './projects.service';
import {
  CreateProjectDto,
  UpdateMemberRoleDto,
  UpdateProjectDto,
} from './dto/projects.dto';

@ApiTags('projects')
@Controller('projects')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ProjectsController {
  constructor(private projectsService: ProjectsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a project (you become its ADMIN)' })
  async create(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateProjectDto,
  ) {
    return this.projectsService.create(req.user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Projects I belong to (not archived)' })
  async list(@Request() req: AuthenticatedRequest) {
    return this.projectsService.list(req.user.sub);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a project I belong to' })
  async findOne(@Request() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.projectsService.findOne(req.user.sub, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename, recolor or archive a project (ADMIN)' })
  async update(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectsService.update(req.user.sub, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a project and its tasks (ADMIN)' })
  async remove(@Request() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.projectsService.remove(req.user.sub, id);
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'List members (email shown to ADMIN only)' })
  async listMembers(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.projectsService.listMembers(req.user.sub, id);
  }

  @Patch(':id/members/:userId')
  @ApiOperation({ summary: "Change a member's role (ADMIN)" })
  async updateMemberRole(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.projectsService.updateMemberRole(req.user.sub, id, userId, dto);
  }

  @Delete(':id/members/:userId')
  @ApiOperation({ summary: 'Remove a member (ADMIN), or leave (yourself)' })
  async removeMember(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.projectsService.removeMember(req.user.sub, id, userId);
  }
}
