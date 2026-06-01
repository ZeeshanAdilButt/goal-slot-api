import { Module } from '@nestjs/common';
import { NotesController } from './notes.controller';
import { PublicNotesController } from './public-notes.controller';
import { NotesService } from './notes.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [NotesController, PublicNotesController],
  providers: [NotesService],
  exports: [NotesService],
})
export class NotesModule {}
