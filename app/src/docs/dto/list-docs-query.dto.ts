import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListDocsQueryDto {
  // Query-string values are always strings; @Type converts "10" -> 10 BEFORE validation.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20; // default applies when ?limit= is absent

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  cursor?: string;
}
