import { IsNotEmpty, IsString, IsUrl, MaxLength } from 'class-validator';

export class RemoveWebPushSubscriptionDto {
  @IsString({ message: 'Endpoint must be a string' })
  @IsNotEmpty({ message: 'Endpoint is required' })
  @IsUrl(
    { require_protocol: true, protocols: ['https'] },
    { message: 'Please enter a valid HTTPS endpoint URL' },
  )
  @MaxLength(4000, { message: 'Endpoint is too long' })
  endpoint: string;
}
