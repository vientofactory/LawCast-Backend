import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsUrl,
  IsNotEmpty,
  Matches,
  MaxLength,
} from 'class-validator';
import { APP_CONSTANTS } from '../../../config/app.config';

const DISCORD_WEBHOOK_URL_PATTERN =
  /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[a-zA-Z0-9_-]+$/;

export class CreateWebhookDto {
  @IsString({ message: 'URL must be a string' })
  @IsNotEmpty({ message: 'URL is required' })
  @IsUrl(
    { require_protocol: true, protocols: ['https'] },
    { message: 'Please enter a valid HTTPS URL' },
  )
  @Matches(DISCORD_WEBHOOK_URL_PATTERN, {
    message: 'Invalid Discord webhook URL format',
  })
  @MaxLength(APP_CONSTANTS.DISCORD.WEBHOOK.URL_MAX_LENGTH, {
    message: `URL cannot exceed ${APP_CONSTANTS.DISCORD.WEBHOOK.URL_MAX_LENGTH} characters`,
  })
  @ApiProperty({
    maxLength: APP_CONSTANTS.DISCORD.WEBHOOK.URL_MAX_LENGTH,
    minLength: 1,
    format: 'uri',
    pattern: DISCORD_WEBHOOK_URL_PATTERN.source,
  })
  url: string;

  @IsString({ message: 'Proof token must be a string' })
  @IsNotEmpty({ message: 'Proof token is required' })
  @MaxLength(3000, { message: 'Proof token is too long' })
  @ApiProperty({ maxLength: 3000, minLength: 1, writeOnly: true })
  proof: string;
}
