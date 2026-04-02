import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
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

@Injectable()
export class LlmProviderService {
  private readonly logger = new Logger(LlmProviderService.name);
  private openai: OpenAI | null = null;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
    }
  }

  /**
   * Analyze the provided GitHub data using LLM or Mock
   */
  async analyze(data: CollectedDataDto): Promise<LlmAnalysisResult> {
    if (!this.openai) {
      this.logger.warn('OPENAI_API_KEY not found. Using Mock Analysis.');
      return this.generateMockAnalysis();
    }

    try {
      // In a real scenario, we would chunk and batch the data
      // For now, let's assume it fits in a single prompt for demonstration
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

      return JSON.parse(content) as LlmAnalysisResult;
    } catch (error) {
      this.logger.error('LLM Analysis failed, falling back to mock.', error);
      return this.generateMockAnalysis();
    }
  }

  private generateMockAnalysis(): LlmAnalysisResult {
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
}
