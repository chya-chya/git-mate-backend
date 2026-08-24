import { Prisma } from '@prisma/client';

export const analysisJobApiInclude = {
  repository: {
    select: {
      id: true,
      githubRepoId: true,
      fullName: true,
    },
  },
  report: {
    select: {
      id: true,
    },
  },
} satisfies Prisma.AnalysisJobInclude;

export type AnalysisJobApiRecord = Prisma.AnalysisJobGetPayload<{
  include: typeof analysisJobApiInclude;
}>;

export interface AnalysisJobCursor {
  createdAt: Date;
  id: string;
}
