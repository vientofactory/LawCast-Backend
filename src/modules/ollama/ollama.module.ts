import { Module } from '@nestjs/common';
import { OllamaClientService } from './ollama-client.service';

@Module({
  providers: [OllamaClientService],
  exports: [OllamaClientService],
})
export class OllamaModule {}
