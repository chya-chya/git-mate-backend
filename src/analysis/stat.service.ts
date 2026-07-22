import { Injectable } from '@nestjs/common';
import type { UserStat } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AnalysisMetrics } from './metric-calculator.service';

@Injectable()
export class StatService {
  constructor(private prisma: PrismaService) {}

  /**
   * Update user stats using weighted average
   */
  async updateStats(
    userId: number,
    newMetrics: AnalysisMetrics,
  ): Promise<UserStat> {
    const existingStat = await this.prisma.userStat.findUnique({
      where: { userId },
    });

    if (!existingStat) {
      // Create new stat if not exists
      return this.prisma.userStat.create({
        data: {
          userId,
          ...newMetrics,
          analysisCount: 1,
        },
      });
    }

    // Weighted average (Simplification: assuming count = 1 for now or 5:5 weight)
    const weightOld = 0.7; // Historical weight
    const weightNew = 0.3; // Recent weight

    const updatedData = {
      mutualRespectScore:
        existingStat.mutualRespectScore * weightOld +
        newMetrics.mutualRespectScore * weightNew,
      conflictManagementScore:
        existingStat.conflictManagementScore * weightOld +
        newMetrics.conflictManagementScore * weightNew,
      logicalProblemScore:
        existingStat.logicalProblemScore * weightOld +
        newMetrics.logicalProblemScore * weightNew,
      reviewGuidingScore:
        existingStat.reviewGuidingScore * weightOld +
        newMetrics.reviewGuidingScore * weightNew,
      documentationScore:
        existingStat.documentationScore * weightOld +
        newMetrics.documentationScore * weightNew,
      knowledgeSharingScore:
        existingStat.knowledgeSharingScore * weightOld +
        newMetrics.knowledgeSharingScore * weightNew,
      technicalInfluenceScore:
        existingStat.technicalInfluenceScore * weightOld +
        newMetrics.technicalInfluenceScore * weightNew,
      codeStabilityScore:
        existingStat.codeStabilityScore * weightOld +
        newMetrics.codeStabilityScore * weightNew,
      analysisCount: {
        increment: 1,
      },
    };

    return this.prisma.userStat.update({
      where: { userId },
      data: updatedData,
    });
  }
}
