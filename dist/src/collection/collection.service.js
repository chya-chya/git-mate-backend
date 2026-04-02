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
exports.CollectionService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma/prisma.service");
const github_provider_1 = require("./github.provider");
const encryption_service_1 = require("../auth/encryption.service");
const analysis_service_1 = require("../analysis/analysis.service");
let CollectionService = class CollectionService {
    prisma;
    githubProvider;
    encryptionService;
    analysisService;
    constructor(prisma, githubProvider, encryptionService, analysisService) {
        this.prisma = prisma;
        this.githubProvider = githubProvider;
        this.encryptionService = encryptionService;
        this.analysisService = analysisService;
    }
    async syncRepository(githubRepoId, userId) {
        const repository = await this.prisma.repository.findUnique({
            where: { githubRepoId },
            include: { owner: true },
        });
        if (!repository) {
            throw new common_1.NotFoundException(`Repository with ID ${githubRepoId} not found`);
        }
        if (repository.ownerId !== userId || !repository.owner.githubToken) {
            throw new common_1.ForbiddenException(`You do not have permission to sync this repository or token is missing`);
        }
        const token = this.encryptionService.decrypt(repository.owner.githubToken);
        const [owner, repoName] = repository.fullName.split('/');
        const githubData = await this.githubProvider.fetchPullRequests(owner, repoName, token, repository.lastSyncTime || undefined);
        const collectedData = {
            githubRepoId,
            pullRequests: githubData.repository.pullRequests.nodes.map((pr) => ({
                number: pr.number,
                title: pr.title,
                body: pr.body,
                author: pr.author.login,
                updatedAt: pr.updatedAt,
                reviews: pr.reviews.nodes.map((review) => ({
                    author: review.author.login,
                    body: review.body,
                    state: review.state,
                    comments: review.comments.nodes.map((comment) => ({
                        author: comment.author.login,
                        body: comment.body,
                        createdAt: comment.createdAt,
                    })),
                })),
            })),
        };
        await this.prisma.repository.update({
            where: { githubRepoId },
            data: { lastSyncTime: new Date() },
        });
        this.analysisService.runAnalysis(userId, repository.id, collectedData)
            .catch(err => console.error('Background analysis failed:', err));
        return collectedData;
    }
    async getRepositories(userId) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        });
        if (!user || !user.githubToken) {
            throw new common_1.ForbiddenException('User token missing');
        }
        const token = this.encryptionService.decrypt(user.githubToken);
        const githubRepos = await this.githubProvider.fetchRepositories(token);
        const upsertPromises = githubRepos.map((repo) => this.prisma.repository.upsert({
            where: { githubRepoId: String(repo.id) },
            update: {
                fullName: repo.full_name,
            },
            create: {
                githubRepoId: String(repo.id),
                fullName: repo.full_name,
                ownerId: userId,
            },
        }));
        await Promise.all(upsertPromises);
        return this.prisma.repository.findMany({
            where: { ownerId: userId },
            orderBy: { fullName: 'asc' },
        });
    }
};
exports.CollectionService = CollectionService;
exports.CollectionService = CollectionService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        github_provider_1.GithubProvider,
        encryption_service_1.EncryptionService,
        analysis_service_1.AnalysisService])
], CollectionService);
//# sourceMappingURL=collection.service.js.map