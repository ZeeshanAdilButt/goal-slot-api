import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import {
  ProjectInviteTokensController,
  ProjectInvitesController,
} from './project-invites.controller';
import { ProjectInvitesService } from './project-invites.service';

@Module({
  // Token routes first, so /projects/invites/:token is never matched as a
  // project id by ProjectsController.
  controllers: [
    ProjectInviteTokensController,
    ProjectInvitesController,
    ProjectsController,
  ],
  providers: [ProjectsService, ProjectInvitesService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
