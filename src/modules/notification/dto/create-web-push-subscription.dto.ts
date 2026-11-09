import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateWebPushSubscriptionDto {
  @IsString({ message: 'Endpoint must be a string' })
  @IsNotEmpty({ message: 'Endpoint is required' })
  @IsUrl(
    { require_protocol: true, protocols: ['https'] },
    { message: 'Please enter a valid HTTPS endpoint URL' },
  )
  @MaxLength(4000, { message: 'Endpoint is too long' })
  @ApiProperty({
    maxLength: 4000,
    minLength: 1,
    format: 'uri',
    pattern: '^https://',
  })
  endpoint: string;

  @IsString({ message: 'p256dh must be a string' })
  @IsNotEmpty({ message: 'p256dh is required' })
  @MaxLength(512, { message: 'p256dh is too long' })
  @ApiProperty({ maxLength: 512, minLength: 1 })
  p256dh: string;

  @IsString({ message: 'auth must be a string' })
  @IsNotEmpty({ message: 'auth is required' })
  @MaxLength(256, { message: 'auth is too long' })
  @ApiProperty({ maxLength: 256, minLength: 1 })
  auth: string;

  @IsString({ message: 'Proof token must be a string' })
  @IsNotEmpty({ message: 'Proof token is required' })
  @MaxLength(3000, { message: 'Proof token is too long' })
  @ApiProperty({ maxLength: 3000, minLength: 1, writeOnly: true })
  proof: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @ApiPropertyOptional({ minimum: 1, type: 'integer' })
  threadId?: number;
}
