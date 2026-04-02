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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var LlmProviderService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.LlmProviderService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const openai_1 = __importDefault(require("openai"));
let LlmProviderService = LlmProviderService_1 = class LlmProviderService {
    configService;
    logger = new common_1.Logger(LlmProviderService_1.name);
    openai = null;
    constructor(configService) {
        this.configService = configService;
        const apiKey = this.configService.get('OPENAI_API_KEY');
        if (apiKey) {
            this.openai = new openai_1.default({ apiKey });
        }
    }
    async analyze(data) {
        if (!this.openai) {
            this.logger.warn('OPENAI_API_KEY not found. Using Mock Analysis.');
            return this.generateMockAnalysis();
        }
        try {
            const prompt = JSON.stringify(data);
            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: '당신은 시니어 백엔드 개발자이자 HR 전문가입니다. 제공된 코드 리뷰 쓰레드를 분석하여 JSON 스키마에 맞게 평가를 반환하세요. 응답은 반드시 유효한 JSON이어야 합니다.',
                    },
                    { role: 'user', content: prompt },
                ],
                response_format: { type: 'json_object' },
            });
            const content = response.choices[0].message.content;
            if (!content) {
                throw new Error('LLM returned empty content');
            }
            return JSON.parse(content);
        }
        catch (error) {
            this.logger.error('LLM Analysis failed, falling back to mock.', error);
            return this.generateMockAnalysis();
        }
    }
    generateMockAnalysis() {
        return {
            communication_style: '제안형',
            actionable_score: 85,
            tech_domains: {
                business_logic: 40,
                architecture: 30,
                database: 20,
                infrastructure: 10,
            },
            feedback_acceptance: '수용적',
            conflict_resolution_time_hours: 12.5,
            key_keywords: ['concurrency', 'transaction', 'refactoring'],
        };
    }
};
exports.LlmProviderService = LlmProviderService;
exports.LlmProviderService = LlmProviderService = LlmProviderService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], LlmProviderService);
//# sourceMappingURL=llm-provider.service.js.map