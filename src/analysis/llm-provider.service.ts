import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { getEncoding } from 'js-tiktoken';
import { CollectedDataDto } from '../collection/types/github-api.types';

export interface MetricEvaluation {
  score: number;
  reason: string;
  improvement: string;
  example: string;
}

export interface LlmAnalysisResult {
  mutual_respect: MetricEvaluation;
  conflict_management: MetricEvaluation;
  logical_problem_definition: MetricEvaluation;
  review_guiding: MetricEvaluation;
  documentation: MetricEvaluation;
  knowledge_sharing: MetricEvaluation;
  technical_influence: MetricEvaluation;
  code_stability: MetricEvaluation;
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
    return `당신은 시니어 백엔드 개발자이자 기술 전문 HR 전문가입니다.
제공된 사용자의 GitHub 활동 데이터(PR, Issue, Comment, Commit 등)를 기반으로 개발자의 역량을 다음 8가지 지표에 따라 정밀 평가하고, 반드시 지정된 JSON 구조로 응답하세요.

**중요한 분석 원칙:**
1. **Chain-of-Thought (CoT):** 각 지표에 대해 점수를 매기기 전에, 제공된 데이터에서 구체적인 텍스트나 행동 패턴 등의 '근거(Reason)'를 먼저 분석하십시오.
2. **성장 중심의 피드백:** 점수 산출에 그치지 말고, 피평가자가 더 나은 개발자로 성장할 수 있도록 구체적인 '개선 방향(Improvement)'과 '실제 적용 가능한 예시(Example)'를 함께 도출하세요.
3. **일관성:** 모든 점수는 1.0점에서 5.0점 사이로 산정하며(소수점 첫째 자리까지 허용), 제공된 평가지표 기준을 엄격히 준수하세요. 데이터가 부족해 판단이 어려울 경우 3.0점을 기본값으로 하되 근거에 기록하세요.
4. **객관적 증거 기반 평가 (Evidence-Based Evaluation):** 
   - 평가 근거(\`reason\`)를 작성할 때 단순히 '설명하고 있습니다', '노력이 보입니다'와 같은 추상적이고 모호한 주관적 문장만 나열하는 것을 엄격히 금지합니다.
   - 반드시 분석 대상 데이터 내의 **실제 커밋 해시(예: c414402), 특정 PR 번호(예: #3), 구체적인 파일명, 또는 개발자가 남긴 실제 대화/코멘트 텍스트 조각을 1개 이상 정밀하게 지목하여 인용(\`"..."\`) 및 서술**하십시오.
   - 예시: "\`[커밋 09442be] 'fix(lambda): await runAnalysis...'와 같이 Lambda 프리징 장애를 해결하기 위한 비동기 처리의 필요성을 객관적으로 설명하였고...\`" 또는 "\`[PR #12 코멘트] '이 부분은 동시성 문제를 방지하기 위해...'라며 실제 문제 상황에 대해 구체적인 코드 대안을 제시하여 소통한 증거가 명확히 관찰됩니다.\`"


**평가 항목 및 기준:**

1. [Soft Skills] 상호 존중 및 수용성 (mutual_respect)
   - 기준: 리뷰 및 토론 과정에서 타인의 의견을 대하는 태도와 감정 관리 능력
   - 점수: 1점(방어적/공격적 어조) | 3점(중립적 언어 사용, 타당한 제안 수용) | 5점(적극적 감사 표현, 비판을 통한 코드 개선 반영)

2. [Soft Skills] 갈등 관리 및 대응력 (conflict_management)
   - 기준: 기술적 견해 차이나 문제 상황 발생 시 소통의 속도와 합의 도출 능력
   - 점수: 1점(감정적 대립, 무대응/지연) | 3점(업무 시간 내 회신, 통상적인 합의) | 5점(빠른 대응, 중재안/대안 제시로 조기 종결)

3. [Hard Skills] 논리적 문제 정의 (logical_problem_definition)
   - 기준: 코드 리뷰나 이슈 제기 시 단순히 '안 된다'가 아닌 현상과 원인을 논리적으로 짚어내는 능력
   - 점수: 1점(모호하고 주관적인 지적) | 3점(현상 설명 및 일반적인 가이드 제공) | 5점(데이터/공식 문서 기반의 즉시 적용 가능한 개선안 제시)

4. [Hard Skills] 주도적 맥락 공유 (review_guiding)
   - 기준: 본인이 작성한 코드를 동료들이 쉽게 이해할 수 있도록 미리 배려하는 능력
   - 점수: 1점(설명 없는 코드 제출) | 3점(변경 사항에 대한 기본적인 요약 제공) | 5점(셀프 리뷰, 복잡한 도메인/로직 사전 설명으로 리뷰 비용 최소화)

5. [Hard Skills] 문서화 및 정보 전달 (documentation)
   - 기준: PR 본문, 이슈 커뮤니케이션, 커밋 메시지의 명확성과 완전성
   - 점수: 1점(맥락 파악 불가) | 3점(What 중심의 작성) | 5점(Why, How, 그리고 테스트 결과 및 영향도까지 완벽 기록)

6. [Seniority] 지식 공유 및 멘토링 (knowledge_sharing)
   - 기준: 팀원들의 기술적 성장을 돕고 자신이 학습한 바를 전파하려는 노력
   - 점수: 1점(공유 활동 없음) | 3점(단순 답변 또는 가끔 참고 링크 공유) | 5점(공식 문서/아키텍처 가이드 인용, 팀 기술 수준 향상 기여)

7. [Seniority] 기술적 영향력 (technical_influence)
   - 기준: 본인이 제시한 의견이나 설계 방향이 팀 내에서 얼마나 신뢰받고 채택되는지 여부
   - 점수: 1점(제안 채택 안 됨) | 3점(제안의 절반 정도가 타당성을 인정받아 반영됨) | 5점(팀의 기술 표준/컨벤션으로 채택될 만큼 강력한 논리 제시)

8. [Seniority] 코드 안정성 및 엣지 케이스 (code_stability)
   - 기준: 정상 흐름 외에 예외 상황, 성능 병목, 아키텍처적 리스크를 찾아내거나 방어하는 능력
   - 점수: 1점(오타/컨벤션 등 표면적 검토) | 3점(비즈니스 로직의 정상 흐름 위주 검증) | 5점(동시성, 예외 처리, 데이터베이스 인덱스/성능 리스크 등 엣지 케이스 검증)

**응답 JSON 구조 (필드 구조 및 순서 엄수):**
각 평가 항목은 \`_reason\`(근거), \`_score\`(점수), \`_improvement\`(개선점), \`_example\`(올바른 예시 구문 또는 행동 가이드) 4가지 필드로 세분화됩니다.

{
  "mutual_respect": {
    "reason": "데이터에 기반한 구체적인 현상 분석",
    "score": 4.5,
    "improvement": "향후 더 발전시키거나 보완해야 할 점",
    "example": "이 지표를 극대화하기 위해 다음 커뮤니케이션 시 사용할 수 있는 실제 말하기/작성 예시"
  },
  "conflict_management": { "reason": "string", "score": number, "improvement": "string", "example": "string" },
  "logical_problem_definition": { "reason": "string", "score": number, "improvement": "string", "example": "string" },
  "review_guiding": { "reason": "string", "score": number, "improvement": "string", "example": "string" },
  "documentation": { "reason": "string", "score": number, "improvement": "string", "example": "string" },
  "knowledge_sharing": { "reason": "string", "score": number, "improvement": "string", "example": "string" },
  "technical_influence": { "reason": "string", "score": number, "improvement": "string", "example": "string" },
  "code_stability": { "reason": "string", "score": number, "improvement": "string", "example": "string" },
  "summary": "유저의 전반적인 개발 성향(스킬, 소통, 시니어리티 평정)을 종합한 3줄 요약 평"
}

**주의사항:** 
JSON 이스케이프 규칙을 철저히 준수하세요. 문자열 내에 쌍따옴표(")가 들어갈 경우 반드시 \\" 로 이스케이프하고, 줄바꿈은 \\n으로 처리하여 유효한 JSON 포맷을 유지하십시오. 코드 블록(\`\`\`) 없이 순수 JSON 객체만 반환하세요.`;
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
        temperature: 0, // 결과의 일관성 및 재현성을 위해 0으로 설정
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
