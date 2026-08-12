import { Module } from '@nestjs/common';
import { InstructionsController } from './instructions.controller';
import { InstructionsService } from './instructions.service';

@Module({
  controllers: [InstructionsController],
  providers: [InstructionsService],
  exports: [InstructionsService],
})
export class InstructionsModule {}
