import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class UpdateWebPushPreferencesDto {
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

  @IsBoolean()
  @ApiProperty()
  noticeNotificationsEnabled: boolean;
}
