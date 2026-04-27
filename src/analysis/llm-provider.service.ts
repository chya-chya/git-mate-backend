import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { getEncoding } from 'js-tiktoken';
import { CollectedDataDto } from '../collection/types/github-api.types';

export interface LlmAnalysisResult {
  mutual_respect: number;
  mutual_respect_reason: string;
  conflict_management: number;
  conflict_management_reason: string;
  logical_problem_definition: number;
  logical_problem_definition_reason: string;
  review_guiding: number;
  review_guiding_reason: string;
  documentation: number;
  documentation_reason: string;
  knowledge_sharing: number;
  knowledge_sharing_reason: string;
  technical_influence: number;
  technical_influence_reason: string;
  code_stability: number;
  code_stability_reason: string;
  summary: string;
}

export interface LlmAnalysisResponse {
  result: LlmAnalysisResult;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
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

  private buildSystemPrompt() {
    return `당신은 시니어 백엔드 개발자이자 HR 전문가입니다.
제공된 GitHub 활동 데이터를 기반으로 개발자의 역량을 다음 8가지 지표에 따라 평가하고, 반드시 지정된 JSON 구조로 응답하세요.
모든 점수는 1점에서 5점 사이의 점수로 산정(소수점 첫 번째 자리까지 허용, 예: 4.3)하며, 각 점수에 대한 구체적인 분석 근거(reason)를 포함해야 합니다.

**평가 항목 및 기준:**

1. [Soft Skills] 상호 존중 및 수용성 (mutual_respect)
   - 1점: 공격적 어조, 비판에 방어적
   - 3점: 중립적 언어 사용, 타당한 제안 수용
   - 5점: 감사와 존중 표현, 비판 수용 및 코드 개선 반영

2. [Soft Skills] 갈등 관리 및 대응력 (conflict_management)
   - 1점: 회신 매우 늦음, 감정적 대립으로 합의 지연
   - 3점: 업무 시간 내 회신, 통상적인 논의로 합의
   - 5점: 긴급도에 따른 빠른 대응, 중재안 제시로 갈등 조기 종결

3. [Hard Skills] 논리적 문제 정의 (logical_problem_definition)
   - 1점: 주관적 느낌이나 모호한 지적
   - 3점: 현상 설명 및 일반적인 기술 가이드 제공
   - 5점: 데이터/공식 문서 기반의 즉시 적용 가능한 개선안(Actionable) 제시

4. [Hard Skills] 주도적 맥락 공유 (review_guiding)
   - 1점: 설명 없이 코드만 제출하여 리뷰어 혼란 야기
   - 3점: 변경 기능에 대한 기본적인 요약 설명 제공
   - 5점: 셀프 리뷰를 통해 복잡한 로직을 미리 설명하여 리뷰 비용 최소화

5. [Hard Skills] 문서화 및 정보 전달 (documentation)
   - 1점: PR 본문 비어있거나 맥락 파악 불가
   - 3점: '무엇을(What)' 했는지 성실히 작성
   - 5점: '왜(Why)'와 '어떻게(How)'를 포함해 테스트 결과까지 완벽히 기록

6. [Seniority] 지식 공유 및 멘토링 (knowledge_sharing)
   - 1점: 지식 공유 활동 없음, 본인 작업에만 집중
   - 3점: 질문 답변 또는 가끔 참고 링크 공유
   - 5점: 관련 논문/블로그/공식 문서를 인용해 팀의 기술 수준 향상 기여

7. [Seniority] 기술적 영향력 (technical_influence)
   - 1점: 제안이 거의 채택되지 않거나 검토 대상 제외
   - 3점: 제안의 절반 정도가 타당성 인정받아 반영됨
   - 5점: 팀의 기술 표준으로 채택될 만큼 강력하고 신뢰받는 의견 제시

8. [Seniority] 코드 안정성 및 엣지 케이스 (code_stability)
   - 1점: 오타나 컨벤션 등 표면적인 부분만 검토
   - 3점: 비즈니스 로직의 정상 흐름 위주 검증
   - 5점: 성능 병목, 보안, 복잡한 예외 상황(Edge Case)을 날카롭게 찾아냄

**응답 JSON 구조:**
{
  "mutual_respect": number,
  "mutual_respect_reason": "string",
  "conflict_management": number,
  "conflict_management_reason": "string",
  "logical_problem_definition": number,
  "logical_problem_definition_reason": "string",
  "review_guiding": number,
  "review_guiding_reason": "string",
  "documentation": number,
  "documentation_reason": "string",
  "knowledge_sharing": number,
  "knowledge_sharing_reason": "string",
  "technical_influence": number,
  "technical_influence_reason": "string",
  "code_stability": number,
  "code_stability_reason": "string",
  "summary": "string (전체 평가 요약)"
}
`;
  }

  async analyze(data: CollectedDataDto): Promise<LlmAnalysisResponse> {
    if (!this.openai) {
      throw new Error('OPENAI_API_KEY not found. LLM Analysis cannot proceed.');
    }

    const rawDataPrompt = JSON.stringify(data);
    const systemPrompt = this.buildSystemPrompt();
    const languageInstruction =
      '\n\n**중요:** 모든 분석 근거(reason)와 요약(summary)은 반드시 **한국어**로 작성하세요.';

    try {
      const messages: any[] = [
        {
          role: 'system',
          content: systemPrompt + languageInstruction,
        },
        {
          role: 'user',
          content: `다음 데이터를 분석하여 JSON 형식으로 응답하세요: \n${rawDataPrompt}`,
        },
      ];

      // 토큰 측정 및 제한 확인 (10만 토큰)
      const estimatedTokens = this.getEstimatedTokenCount(messages);
      if (estimatedTokens > 100000) {
        throw new Error(
          `Token limit exceeded: ${estimatedTokens} tokens (Limit: 100000)`,
        );
      }

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o', // 최신 모델 사용 권장
        messages: messages,
        response_format: { type: 'json_object' },
      });

      const usage = response.usage;
      if (usage) {
        this.logger.log(
          `LLM Actual Usage - Prompt: ${usage.prompt_tokens}, Completion: ${usage.completion_tokens}, Total: ${usage.total_tokens}`,
        );
      }

      const result = JSON.parse(
        response.choices[0].message.content || '{}',
      ) as LlmAnalysisResult;

      return {
        result,
        usage: {
          promptTokens: usage?.prompt_tokens || 0,
          completionTokens: usage?.completion_tokens || 0,
          totalTokens: usage?.total_tokens || 0,
        },
      };
    } catch (error) {
      this.logger.error('LLM Analysis failed:', error);
      throw error;
    }
  }

  estimateTokensForData(data: CollectedDataDto): number {
    const rawDataPrompt = JSON.stringify(data);
    const systemPrompt = this.buildSystemPrompt();
    const languageInstruction =
      '\n\n**중요:** 모든 분석 근거(reason)와 요약(summary)은 반드시 **한국어**로 작성하세요.';

    const messages: any[] = [
      {
        role: 'system',
        content: systemPrompt + languageInstruction,
      },
      {
        role: 'user',
        content: `다음 데이터를 분석하여 JSON 형식으로 응답하세요: \n${rawDataPrompt}`,
      },
    ];

    return this.getEstimatedTokenCount(messages);
  }

  private getEstimatedTokenCount(messages: any[]): number {
    try {
      const encoding = getEncoding('cl100k_base');
      let totalTokens = 0;

      for (const message of messages) {
        totalTokens += 4;
        totalTokens += encoding.encode(message.content || '').length;
      }
      totalTokens += 3;

      this.logger.log(`Estimated Prompt Tokens: ${totalTokens}`);
      return totalTokens;
    } catch (e) {
      this.logger.warn('Failed to estimate tokens', e);
      return 0;
    }
  }
}
