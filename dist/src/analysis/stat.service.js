"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma/prisma.service");
let StatService = class StatService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async updateStats(userId, newMetrics) {
        const existingStat = await this.prisma.userStat.findUnique({
            where: { userId },
        });
        if (!existingStat) {
            return this.prisma.userStat.create({
                data: {
                    userId,
                    ...newMetrics,
                },
            });
        }
        const weightOld = 0.7;
        const weightNew = 0.3;
        const updatedData = {
            actionableScore: existingStat.actionableScore * weightOld + newMetrics.actionableScore * weightNew,
            feedbackAcceptScore: existingStat.feedbackAcceptScore * weightOld + newMetrics.feedbackAcceptScore * weightNew,
            avgCycleTimeHours: existingStat.avgCycleTimeHours * weightOld + newMetrics.avgCycleTimeHours * weightNew,
            logicScore: existingStat.logicScore * weightOld + newMetrics.logicScore * weightNew,
            architectureScore: existingStat.architectureScore * weightOld + newMetrics.architectureScore * weightNew,
            dbScore: existingStat.dbScore * weightOld + newMetrics.dbScore * weightNew,
            infraScore: existingStat.infraScore * weightOld + newMetrics.infraScore * weightNew,
        };
        return this.prisma.userStat.update({
            where: { userId },
            data: updatedData,
        });
    }
};
exports.StatService = StatService;
exports.StatService = StatService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], StatService);
//# sourceMappingURL=stat.service.js.map