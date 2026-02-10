import { IsString, IsOptional, IsBoolean, IsNumber } from 'class-validator';

export class CreateNoteDto {
  @IsString()
  title: string;

  @IsString()
  @IsOptional()
  content?: string;

  @IsString()
  @IsOptional()
  icon?: string;

  @IsString()
  @IsOptional()
  color?: string;

  @IsString()
  @IsOptional()
  parentId?: string | null;
}

export class UpdateNoteDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  content?: string;

  @IsString()
  @IsOptional()
  icon?: string;

  @IsString()
  @IsOptional()
  color?: string;

  @IsString()
  @IsOptional()
  parentId?: string | null;

  @IsNumber()
  @IsOptional()
  order?: number;

  @IsBoolean()
  @IsOptional()
  isExpanded?: boolean;

  @IsBoolean()
  @IsOptional()
  isFavorite?: boolean;
}

export class ReorderNotesDto {
  @IsString()
  noteId: string;

  @IsString()
  @IsOptional()
  parentId: string | null;

  @IsNumber()
  order: number;
}
