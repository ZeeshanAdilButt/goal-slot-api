import {
  IsString,
  IsOptional,
  IsBoolean,
  IsArray,
  IsObject,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ExcalidrawElementDto {
  @IsString()
  id!: string;

  @IsString()
  type!: string;
}

export class ExcalidrawSceneDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExcalidrawElementDto)
  elements!: ExcalidrawElementDto[];

  @IsObject()
  appState!: Record<string, any>;

  @IsObject()
  files!: Record<string, any>;
}

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
  @IsObject()
  @ValidateNested()
  @Type(() => ExcalidrawSceneDto)
  content?: ExcalidrawSceneDto;

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