import { PrismaService } from '../prisma/prisma.service';
export declare class StatService {
    private prisma;
    constructor(prisma: PrismaService);
    updateStats(userId: number, newMetrics: any): Promise<any>;
}
