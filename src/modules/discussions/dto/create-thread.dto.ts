import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateThreadDto {
  @IsString()
  @IsNotEmpty({ message: '토론 제목을 입력해주세요.' })
  @MinLength(2, { message: '토론 제목은 최소 2자 이상이어야 합니다.' })
  @MaxLength(150, { message: '토론 제목은 최대 150자까지 가능합니다.' })
  @ApiProperty({ minLength: 2, maxLength: 150 })
  title: string;

  @IsString()
  @IsOptional()
  @MaxLength(30, { message: '닉네임은 최대 30자까지 가능합니다.' })
  @ApiPropertyOptional({ maxLength: 30 })
  authorNickname?: string;

  @IsString()
  @IsNotEmpty({ message: '비밀번호를 입력해주세요.' })
  @MinLength(4, { message: '비밀번호는 최소 4자 이상이어야 합니다.' })
  @MaxLength(64, { message: '비밀번호는 최대 64자까지 가능합니다.' })
  @ApiProperty({
    minLength: 4,
    maxLength: 64,
    format: 'password',
    writeOnly: true,
  })
  password: string;

  @IsString()
  @IsNotEmpty({ message: '토론 시작 의견을 입력해주세요.' })
  @MinLength(2, { message: '의견 본문은 최소 2자 이상이어야 합니다.' })
  @MaxLength(5000, { message: '의견 본문은 최대 5000자까지 가능합니다.' })
  @ApiProperty({ minLength: 2, maxLength: 5000 })
  content: string;
}
