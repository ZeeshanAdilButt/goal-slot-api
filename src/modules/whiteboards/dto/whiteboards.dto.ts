import { IsString, IsOptional, IsBoolean } from 'class-validator';

export class CreateWhiteboardDto {
  @IsString()
  title!: string;

  @IsString()
  @IsOptional()
  icon?: string;

  @IsString()
  @IsOptional()
  color?: string;
}

export class UpdateWhiteboardDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsOptional()
  content?: any; // Excalidraw scene JSON

  @IsString()
  @IsOptional()
  icon?: string;

  @IsString()
  @IsOptional()
  color?: string;

  @IsBoolean()
  @IsOptional()
  isFavorite?: boolean;
}