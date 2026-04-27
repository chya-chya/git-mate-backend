import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AnalysisService } from './analysis.service';

@ApiTags('Public Analysis')
@Controller('analysis/public')
export class PublicAnalysisController {
  constructor(private readonly analysisService: AnalysisService) {}

  @Get(':username')
  @ApiOperation({ summary: '특정 사용자의 공개된 대표 분석 리포트 조회' })
  async getPublicReport(@Param('username') username: string) {
    const report = await this.analysisService.getPublicReport(username);
    if (!report) {
      throw new NotFoundException(
        `Shared representative report for user ${username} not found`,
      );
    }
    return report;
  }

  @Get()
  @ApiOperation({ summary: '플랫폼에 공유된 모든 대표 분석 리포트 목록 조회' })
  async getAllPublicReports() {
    return this.analysisService.getAllPublicReports();
  }
}
