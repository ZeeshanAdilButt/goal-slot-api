import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AssignInstructionDto {
  @ApiProperty({ description: 'User id of the mentee receiving the instruction' })
  @IsString()
  @IsNotEmpty()
  assigneeId: string;

  @ApiProperty({ example: 'Log time daily this week' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ required: false, example: 'Even a rough estimate is fine, just keep the streak going.' })
  @IsOptional()
  @IsString()
  note?: string;
}
