import { Controller, Get, Param, UseGuards, Req, NotFoundException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { AnalysisService } from './analysis.service';

@ApiTags('Analysis')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('analysis')
export class AnalysisController {
  constructor(private readonly analysisService: AnalysisService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Get current user aggregate stats' })
  async getStats(@Req() req: any) {
    const userId = req.user.id;
    return this.analysisService.getUserStats(userId);
  }

  @Get('reports')
  @ApiOperation({ summary: 'Get user analysis reports' })
  async getReports(@Req() req: any) {
    const userId = req.user.id;
    return this.analysisService.getReports(userId);
  }

  @Get('reports/:id')
  @ApiOperation({ summary: 'Get specific analysis report' })
  async getReport(@Param('id') id: string, @Req() req: any) {
    const userId = req.user.id;
    const report = await this.analysisService.getReportById(Number(id), userId);
    if (!report) {
      throw new NotFoundException(`Report with ID ${id} not found`);
    }
    return report;
  }
}
