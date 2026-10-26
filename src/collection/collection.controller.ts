import {
  Controller,
  Post,
  Get,
  Header,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from '@nestjs/swagger';
import { CollectionService } from './collection.service';
import {
  CollectedDataDto,
  EstimateResponseDto,
} from './types/github-api.types';
import type { Repository } from '@prisma/client';
import type { Request } from 'express';

interface AuthenticatedRequest extends Request {
  user: { id: number };
}

@ApiTags('Collection')
@ApiBearerAuth()
@Controller('collection')
export class CollectionController {
  constructor(private readonly collectionService: CollectionService) {}

  @Post('sync/:githubRepoId')
  @UseGuards(AuthGuard('jwt'))
  @Header('Deprecation', 'true')
  @Header('Link', '</analysis/jobs>; rel="successor-version"')
  @ApiOperation({
    summary: 'GitHub 저장소 PR 동기화 (기존 동기 경로)',
    description:
      '신규 호출은 POST /analysis/jobs를 사용하세요. 이 동기 API는 점진 전환 기간에만 유지됩니다.',
    deprecated: true,
  })
  @ApiResponse({
    status: 200,
    type: CollectedDataDto,
    headers: {
      Deprecation: {
        description: '이 동기 API가 deprecated 상태임을 표시',
        schema: { type: 'string', example: 'true' },
      },
      Link: {
        description: '후속 비동기 Job API',
        schema: {
          type: 'string',
          example: '</analysis/jobs>; rel="successor-version"',
        },
      },
    },
  })
  async sync(
    @Param('githubRepoId') githubRepoId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<CollectedDataDto> {
    return this.collectionService.syncRepository(githubRepoId, req.user.id);
  }

  @Get('estimate-cost/:githubRepoId')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: '동기화 전 예상 비용(PR 및 토큰 수) 추정' })
  @ApiResponse({ status: 200, type: EstimateResponseDto })
  async estimateCost(
    @Param('githubRepoId') githubRepoId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<EstimateResponseDto> {
    return this.collectionService.estimateCost(githubRepoId, req.user.id);
  }

  @Get('estimate/:githubRepoId')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({
    summary: '동기화 전 예상 비용(PR 및 토큰 수) 추정 (기존 경로)',
    deprecated: true,
  })
  @ApiResponse({ status: 200, type: EstimateResponseDto })
  async estimate(
    @Param('githubRepoId') githubRepoId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<EstimateResponseDto> {
    return this.collectionService.estimateCost(githubRepoId, req.user.id);
  }

  @Get('repos')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'GitHub 사용자 저장소 목록 조회 및 동기화' })
  async getRepositories(
    @Req() req: AuthenticatedRequest,
  ): Promise<Repository[]> {
    return this.collectionService.getRepositories(req.user.id);
  }
}
