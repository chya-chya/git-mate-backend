import { ApiProperty } from '@nestjs/swagger';

export class GithubReauthorizeUrlDto {
  @ApiProperty({
    example:
      'https://github.com/login/oauth/authorize?client_id=...&redirect_uri=...&scope=read%3Auser+read%3Aorg&state=...',
    description: 'GitHub OAuth URL for permission reauthorization',
  })
  url: string;
}
