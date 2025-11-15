import {
  IsString,
  IsUrl,
  IsNotEmpty,
  Matches,
  MaxLength,
} from 'class-validator';
import { APP_CONSTANTS } from '../config/app.config';

export class CreateWebhookDto {
  @IsString({ message: 'URL은 문자열이어야 합니다.' })
  @IsNotEmpty({ message: 'URL은 필수 입력 항목입니다.' })
  @IsUrl(
    { require_protocol: true, protocols: ['https'] },
    { message: '올바른 HTTPS URL을 입력해주세요.' },
  )
  @Matches(/^https:\/\/discord\.com\/api\/webhooks\/\d+\/[a-zA-Z0-9_-]+$/, {
    message: '올바른 Discord 웹훅 URL 형식이 아닙니다.',
  })
  @MaxLength(APP_CONSTANTS.DISCORD.WEBHOOK.URL_MAX_LENGTH, {
    message: `URL은 ${APP_CONSTANTS.DISCORD.WEBHOOK.URL_MAX_LENGTH}자를 초과할 수 없습니다.`,
  })
  url: string;

  @IsString({ message: 'reCAPTCHA 토큰은 문자열이어야 합니다.' })
  @IsNotEmpty({ message: 'reCAPTCHA 인증이 필요합니다.' })
  @MaxLength(2000, { message: 'reCAPTCHA 토큰이 너무 깁니다.' })
  recaptchaToken: string;
}
