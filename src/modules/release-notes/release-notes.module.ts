import { Module } from '@nestjs/common'
import { ReleaseNotesService } from './release-notes.service'
import { ReleaseNotesController } from './release-notes.controller'
import { PrismaService } from '../../prisma/prisma.service'

@Module({
  controllers: [ReleaseNotesController],
  providers: [ReleaseNotesService, PrismaService],
})
export class ReleaseNotesModule {}
