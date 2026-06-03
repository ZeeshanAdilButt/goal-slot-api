import {
  IsString,
  IsOptional,
  IsBoolean,
  IsArray,
  IsObject,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class ExcalidrawSceneDto {
  @IsArray()
  @IsObject({ each: true })
  elements!: Record<string, unknown>[];

  @IsObject()
  appState!: Record<string, unknown>;

  @IsObject()
  files!: Record<string, unknown>;
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
