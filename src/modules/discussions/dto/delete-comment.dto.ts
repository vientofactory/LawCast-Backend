import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class DeleteCommentDto {
  @IsString()
  @IsNotEmpty({ message: '비밀번호를 입력해주세요.' })
  @MinLength(4, { message: '비밀번호는 최소 4자 이상이어야 합니다.' })
  @MaxLength(64, { message: '비밀번호는 최대 64자까지 가능합니다.' })
  password: string;
}
