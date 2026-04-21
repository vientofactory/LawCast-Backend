import {
  IsString,
  IsUrl,
  IsNotEmpty,
  Matches,
  MaxLength,
} from 'class-validator';
import { APP_CONSTANTS } from '../config/app.config';

export class CreateWebhookDto {
  @IsString({ message: 'URL must be a string' })
  @IsNotEmpty({ message: 'URL is required' })
  @IsUrl(
    { require_protocol: true, protocols: ['https'] },
    { message: 'Please enter a valid HTTPS URL' },
  )
  @Matches(/^https:\/\/discord\.com\/api\/webhooks\/\d+\/[a-zA-Z0-9_-]+$/, {
    message: 'Invalid Discord webhook URL format',
  })
  @MaxLength(APP_CONSTANTS.DISCORD.WEBHOOK.URL_MAX_LENGTH, {
    message: `URL cannot exceed ${APP_CONSTANTS.DISCORD.WEBHOOK.URL_MAX_LENGTH} characters`,
  })
  url: string;

  @IsString({ message: 'Proof token must be a string' })
  @IsNotEmpty({ message: 'Proof token is required' })
  @MaxLength(3000, { message: 'Proof token is too long' })
  proof: string;
}
