import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AnalysisJobStage, AnalysisJobStatus } from '@prisma/client';

export class CreateAnalysisJobDto {
  @ApiProperty({
    description: '양의 GitHub 저장소 ID를 나타내는 숫자 문자열',
    example: '12345678901234567890',
    type: String,
  })
  @IsString()
  @MaxLength(32)
  @Matches(/^[1-9]\d*$/, {
    message: 'githubRepoId must be a positive numeric string',
  })
  githubRepoId!: string;
}

export class ListAnalysisJobsQueryDto {
  @ApiPropertyOptional({
    description: '내부 저장소 ID',
    example: 17,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  repositoryId?: number;

  @ApiPropertyOptional({ enum: AnalysisJobStatus })
  @IsOptional()
  @IsEnum(AnalysisJobStatus)
  status?: AnalysisJobStatus;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional({
    description: '이전 응답의 불투명 페이지네이션 커서',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'cursor is invalid' })
  cursor?: string;
}

export class AnalysisJobRepositoryDto {
  @ApiProperty({ example: 17 })
  id!: number;

  @ApiProperty({ example: '12345678901234567890' })
  githubRepoId!: string;

  @ApiProperty({ example: 'octocat/example' })
  fullName!: string;
}

export class AnalysisJobTokensDto {
  @ApiPropertyOptional({ type: Number, nullable: true, example: 18200 })
  estimated!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 22000 })
  reserved!: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 17640,
    description: 'Provider가 보고한 총 사용 토큰. 과거 데이터는 null일 수 있음',
  })
  consumed!: number | null;
}

export class AnalysisJobResultDto {
  @ApiProperty({ example: 481 })
  reportId!: number;

  @ApiProperty({ example: '/analysis/reports/481' })
  href!: string;
}

export class AnalysisJobErrorDto {
  @ApiProperty({ example: 'INSUFFICIENT_TOKENS' })
  code!: string;

  @ApiProperty({ example: '분석에 필요한 토큰이 부족합니다.' })
  message!: string;

  @ApiProperty({ example: false })
  retryable!: boolean;
}

export class AnalysisJobLinksDto {
  @ApiProperty({
    example: '/analysis/jobs/8fe6a55c-956a-4d8f-985f-fcf2bc72e34c',
  })
  self!: string;
}

export class AnalysisJobResponseDto {
  @ApiProperty({ example: '8fe6a55c-956a-4d8f-985f-fcf2bc72e34c' })
  jobId!: string;

  @ApiProperty({ enum: AnalysisJobStatus })
  status!: AnalysisJobStatus;

  @ApiPropertyOptional({ enum: AnalysisJobStage, nullable: true })
  stage!: AnalysisJobStage | null;

  @ApiProperty({ minimum: 0, maximum: 100, example: 35 })
  progress!: number;

  @ApiProperty({ minimum: 0, example: 1 })
  attempt!: number;

  @ApiProperty({ type: AnalysisJobRepositoryDto })
  repository!: AnalysisJobRepositoryDto;

  @ApiProperty({ type: AnalysisJobTokensDto })
  tokens!: AnalysisJobTokensDto;

  @ApiPropertyOptional({ type: AnalysisJobResultDto, nullable: true })
  result!: AnalysisJobResultDto | null;

  @ApiPropertyOptional({ type: AnalysisJobErrorDto, nullable: true })
  error!: AnalysisJobErrorDto | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  startedAt!: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  completedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({ type: AnalysisJobLinksDto })
  links!: AnalysisJobLinksDto;
}

export class AnalysisJobListResponseDto {
  @ApiProperty({ type: [AnalysisJobResponseDto] })
  items!: AnalysisJobResponseDto[];

  @ApiPropertyOptional({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class AnalysisJobApiErrorDto {
  @ApiProperty({
    example: 'JOB_NOT_FOUND',
    enum: [
      'INVALID_REQUEST',
      'UNAUTHORIZED',
      'REPOSITORY_NOT_FOUND',
      'JOB_NOT_FOUND',
      'IDEMPOTENCY_KEY_REUSED',
      'ACTIVE_JOB_EXISTS',
      'JOB_NOT_RETRYABLE',
      'INSUFFICIENT_TOKENS',
      'RATE_LIMITED',
      'ASYNC_ANALYSIS_DISABLED',
      'JOB_ACCEPTANCE_UNAVAILABLE',
    ],
  })
  code!: string;

  @ApiProperty({ example: 'Analysis job was not found.' })
  message!: string;
}
