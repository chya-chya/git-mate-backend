import { Controller, Post, Get, Param, UseGuards, Req } from '@nestjs/common';
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

@ApiTags('Collection')
@ApiBearerAuth()
@Controller('collection')
export class CollectionController {
  constructor(private readonly collectionService: CollectionService) {}

  @Post('sync/:githubRepoId')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'GitHub 저장소 PR 동기화' })
  @ApiResponse({ status: 200, type: CollectedDataDto })
  async sync(
    @Param('githubRepoId') githubRepoId: string,
    @Req() req: any,
  ): Promise<CollectedDataDto> {
    const user = req.user as { id: number };
    return this.collectionService.syncRepository(githubRepoId, user.id);
  }

  @Get('estimate-cost/:githubRepoId')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: '동기화 전 예상 비용(PR 및 토큰 수) 추정' })
  @ApiResponse({ status: 200, type: EstimateResponseDto })
  async estimateCost(
    @Param('githubRepoId') githubRepoId: string,
    @Req() req: any,
  ): Promise<EstimateResponseDto> {
    const user = req.user as { id: number };
    return this.collectionService.estimateCost(githubRepoId, user.id);
  }

  @Get('repos')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'GitHub 사용자 저장소 목록 조회 및 동기화' })
  async getRepositories(@Req() req: any): Promise<any[]> {
    const user = req.user as { id: number };
    return this.collectionService.getRepositories(user.id);
  }
}
