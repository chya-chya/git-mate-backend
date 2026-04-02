import { ConfigService } from '@nestjs/config';
import { CollectedDataDto } from '../collection/types/github-api.types';
export interface LlmAnalysisResult {
    communication_style: string;
    actionable_score: number;
    tech_domains: {
        business_logic: number;
        architecture: number;
        database: number;
        infrastructure: number;
    };
    feedback_acceptance: string;
    conflict_resolution_time_hours: number;
    key_keywords: string[];
}
export declare class LlmProviderService {
    private configService;
    private readonly logger;
    private openai;
    constructor(configService: ConfigService);
    analyze(data: CollectedDataDto): Promise<LlmAnalysisResult>;
    private generateMockAnalysis;
}
