import {
  Controller,
  Get,
  Param,
  Patch,
  Body,
  UseGuards,
  Req,
  Query,
  NotFoundException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';
import { AnalysisService } from './analysis.service';

interface AuthenticatedRequest extends Request {
  user: {
    id: number;
    username: string;
  };
}

@ApiTags('Analysis')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('analysis')
export class AnalysisController {
  constructor(private readonly analysisService: AnalysisService) {}

  @Get('stats')
  @ApiOperation({ summary: '현재 사용자의 통합 역량 통계 조회' })
  async getStats(@Req() req: AuthenticatedRequest) {
    const userId = req.user.id;
    return this.analysisService.getUserStats(userId);
  }

  @Get('reports')
  @ApiOperation({ summary: '사용자의 모든 분석 리포트 목록 조회' })
  async getReports(
    @Req() req: AuthenticatedRequest,
    @Query('shared') shared?: string,
  ) {
    const userId = req.user.id;
    const isShared =
      shared === 'true' ? true : shared === 'false' ? false : undefined;
    return this.analysisService.getReports(userId, isShared);
  }

  @Get('reports/:id')
  @ApiOperation({ summary: '특정 분석 리포트 상세 조회' })
  async getReport(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const userId = req.user.id;
    const report = await this.analysisService.getReportById(Number(id), userId);
    if (!report) {
      throw new NotFoundException(`Report with ID ${id} not found`);
    }
    return report;
  }

  @Get('status/:id')
  @ApiOperation({ summary: '분석 상태 및 결과 조회 (호환성용)' })
  async getStatus(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const userId = req.user.id;
    const report = await this.analysisService.getReportById(Number(id), userId);

    if (!report) {
      // 리포트가 없으면 아직 분석 중이거나 없는 것으로 간주
      return { status: 'processing', progress: 50 };
    }

    return {
      id: report.id,
      status: 'completed',
      progress: 100,
      result: report,
    };
  }

  @Get('history')
  @ApiOperation({ summary: '분석된 저장소 목록 및 최신 리포트 조회' })
  async getHistory(@Req() req: AuthenticatedRequest) {
    const userId = req.user.id;
    return this.analysisService.getAnalyzedRepositories(userId);
  }

  @Get('history/:repositoryId')
  @ApiOperation({ summary: '특정 저장소의 분석 히스토리 조회' })
  async getRepoHistory(
    @Param('repositoryId') repositoryId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req.user.id;
    return this.analysisService.getReportsByRepository(
      userId,
      Number(repositoryId),
    );
  }

  @Patch('reports/:id/representative')
  @ApiOperation({ summary: '특정 리포트를 대표 분석 결과로 설정' })
  async setRepresentative(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req.user.id;
    return this.analysisService.setRepresentative(userId, Number(id));
  }

  @Patch('reports/:id/share')
  @ApiOperation({ summary: '리포트 공유 상태 토글' })
  async toggleSharing(
    @Param('id') id: string,
    @Body('isShared') isShared: boolean,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req.user.id;
    return this.analysisService.toggleSharing(userId, Number(id), isShared);
  }
}
