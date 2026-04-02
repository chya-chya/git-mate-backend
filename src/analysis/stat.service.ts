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
      actionableScore: existingStat.actionableScore * weightOld + newMetrics.actionableScore * weightNew,
      feedbackAcceptScore: existingStat.feedbackAcceptScore * weightOld + newMetrics.feedbackAcceptScore * weightNew,
      avgCycleTimeHours: existingStat.avgCycleTimeHours * weightOld + newMetrics.avgCycleTimeHours * weightNew,
      logicScore: existingStat.logicScore * weightOld + newMetrics.logicScore * weightNew,
      architectureScore: existingStat.architectureScore * weightOld + newMetrics.architectureScore * weightNew,
      dbScore: existingStat.dbScore * weightOld + newMetrics.dbScore * weightNew,
      infraScore: existingStat.infraScore * weightOld + newMetrics.infraScore * weightNew,
    };

    return (this.prisma as any).userStat.update({
      where: { userId },
      data: updatedData,
    });
  }
}
