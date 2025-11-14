import { IsString, IsUrl } from 'class-validator';

export class CreateWebhookDto {
  @IsString()
  @IsUrl()
  url: string;

  @IsString()
  recaptchaToken: string;
}
