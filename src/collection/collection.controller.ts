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
  @ApiOperation({ summary: 'Sync GitHub Repository PRs' })
  @ApiResponse({ status: 200, type: CollectedDataDto })
  async sync(
    @Param('githubRepoId') githubRepoId: string,
    @Req() req: any,
  ): Promise<CollectedDataDto> {
    const user = req.user as { id: number };
    return this.collectionService.syncRepository(githubRepoId, user.id);
  }

  @Get('estimate/:githubRepoId')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Estimate PR count and tokens without syncing' })
  @ApiResponse({ status: 200, type: EstimateResponseDto })
  async estimate(
    @Param('githubRepoId') githubRepoId: string,
    @Req() req: any,
  ): Promise<EstimateResponseDto> {
    const user = req.user as { id: number };
    return this.collectionService.estimateSync(githubRepoId, user.id);
  }

  @Get('repos')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Get all user repositories from GitHub and sync' })
  async getRepositories(@Req() req: any): Promise<any[]> {
    const user = req.user as { id: number };
    return this.collectionService.getRepositories(user.id);
  }
}
