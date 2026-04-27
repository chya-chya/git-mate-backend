import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StatService {
  constructor(private prisma: PrismaService) {}

  /**
   * Update user stats using weighted average
   */
  async updateStats(userId: number, newMetrics: any) {
    const existingStat = await (this.prisma as any).userStat.findUnique({
      where: { userId },
    });

    if (!existingStat) {
      // Create new stat if not exists
      return (this.prisma as any).userStat.create({
        data: {
          userId,
          ...newMetrics,
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
    };

    return (this.prisma as any).userStat.update({
      where: { userId },
      data: updatedData,
    });
  }
}
