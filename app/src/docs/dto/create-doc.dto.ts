import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';

// Trim whitespace BEFORE validation runs, so "   " becomes "" and fails @Length(1, ...).
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateDocDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @Length(1, 128) // userId becomes part of a DynamoDB key: keep it bounded
  userId: string;

  @Transform(trim)
  @IsString()
  @Length(1, 200)
  title: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
