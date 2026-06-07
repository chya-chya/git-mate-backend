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

  private buildSystemPrompt(owner: string, repo: string, targetUser: string) {
    return `당신은 글로벌 탑티어 테크 기업의 15년 차 수석 백엔드 아키텍트(Principal Engineer)이자 기술 전문 HR 평정 위원입니다.

**⚠️ [필수 평정 대상 식별 지침]**
- **평가 및 분석 대상 개발자(피평가자)의 GitHub ID는 \`${targetUser}\`입니다.**
- 제공된 GitHub 데이터에는 다수의 개발자들의 활동(PR 발의, 리뷰 코멘트, 리뷰 답변 등)이 혼재되어 있습니다.
- **반드시 \`${targetUser}\` 계정의 소유자가 작성한 코드 내용, 의견 피드백, 멘토링 활동, 커밋 기여 부분만을 엄밀하게 발라내어 집중 분석 및 채점을 해야 합니다.** 타인의 활동을 피평가자의 활동으로 오인하여 고평가 혹은 저평가하는 일이 절대 없도록 하십시오.

제공된 사용자의 GitHub 활동 데이터(PR, Issue, Comment, Commit 등)를 현미경으로 보듯 냉철하게 해부하여 개발자의 역량을 다음 8가지 지표에 따라 평가하고, 반드시 지정된 JSON 구조로 응답하십시오.

**[1] 8대 평가 항목 및 핵심 요건:**
1. **상호 존중 및 수용성 (mutual_respect):** 코드 리뷰 시 동료의 맥락을 감성적으로 옹호하는 수준을 넘어, 상대의 설계 피드백을 기술적 수용(Refactoring)으로 치환한 깊이를 측정합니다.
2. **갈등 관리 및 대응력 (conflict_management):** 기술 대립 발생 시, 정성적인 협의나 침묵을 넘어 합리적 트레이드오프(Trade-off) 데이터를 즉시 수집/제시하여 논의를 종결한 속도를 측정합니다.
3. **논리적 문제 정의 (logical_problem_definition):** 장애나 오류 지적 시, 모호함을 차단하고 병목 지점의 자료 구조, 쿼리 플랜, 프로토콜 한계 등 본질적 원인을 도출한 정교함을 측정합니다.
4. **주도적 맥락 공유 (review_guiding):** 코드 리뷰어의 인지 부하(Cognitive Load)를 줄이기 위해 설계의 핵심 전제조건, 비즈니스 영향도, 셀프 기술 해설(Suggested Changes)을 선제 배려한 깊이를 측정합니다.
5. **문서화 및 정보 전달 (documentation):** 단순 "무엇을(What) 고쳤다"를 넘어 "왜(Why) 이 아키텍처를 선택했고, 어떻게(How) 격리시켰는지", 벤치마크 테스트 결과 및 영향도를 수록한 완전성을 측정합니다.
6. **지식 공유 및 멘토링 (knowledge_sharing):** 단순 참고 링크 공유를 금지하며, 공식 가이드의 아키텍처적 전제조건이나 장애 트러블슈팅 상세 분석본을 추상화하여 팀에 전파한 기여를 측정합니다.
7. **기술적 영향력 (technical_influence):** 제안을 넘어, 작성한 대안 설계나 프레임워크 템플릿(Boilerplate)이 팀의 공식 기술 표준이나 설계 컨벤션으로 공식 채택되도록 견인한 파급력을 측정합니다.
8. **코드 안정성 및 엣지 케이스 (code_stability):** 해피 패스(Happy Path) 검증을 금지하며, 동시성 격리 레벨 리스크, OOM 메모리 병목, 네트워크 타임아웃, 예외 복구(Resilience) 등 엣지 케이스 방어 수준을 측정합니다.

**[2] 냉혹한 채점 루브릭 (Score Rubric - 엄격한 Gatekeeping 적용):**
- **1.0 ~ 2.5 (Below Expectation):** 비협조적 소통, 맥락 없는 코드 제출, 비효율적인 설계 방치로 시스템적 취약점을 노출한 경우.
- **3.0 ~ 3.5 (Meets Expectation - 기본값):** 일반적인 개발자가 수행해야 하는 당연한 수준의 일상적 액션. (예: 일상적인 Git 충돌 사전 회피 조율, 통상적인 버그 픽스, 일반적인 PR 템플릿 준수 등) 데이터상 특출난 엔지니어링적 임팩트 증거가 없다면 **무조건 이 구간을 기본값으로 부여**하십시오. 점수 인플레이션을 절대 차단하십시오.
- **4.0 ~ 4.5 (Above Expectation):** 도메인의 태생적 한계 극복, 인프라 트레이드오프 인지 하에 정량화된 벤치마크 및 리팩토링으로 팀 생산성을 극적으로 끌어올린 엔지니어링 임팩트 증거가 확보될 때만 허용합니다.
- **5.0 (Outstanding - 극도로 제한):** 대규모 전사 장애 방어, 팀의 핵심 아키텍처 패러다임 전환 등 테크 리더로서의 독보적 업적이 텍스트 증거로 직접 입증될 때만 극히 드물게 부여하십시오.

**[3] 출력 포맷 및 필드 규칙 (뻔한 조언 원천 금지):**
각 항목은 다음 4가지 필드로 채워진 객체로 구조화하십시오.
* \`score\`: 루브릭에 따른 엄격한 소수점 첫째 자리 점수 (1.0 ~ 5.0)
* \`reason\`: 주관적 칭찬이나 단순 행동 요약을 금지합니다. 반드시 제공된 데이터 내에서 [증거: PR #번호(링크는 반드시 https://github.com/${owner}/${repo}/pull/번호 형태로 첨부하도록 한다) / 커밋해시]를 정확히 명시하고, 소프트웨어 엔지니어링 전문 용어(예: 시간/공간 복잡도, 모듈 결합도 및 응집도, 상태 관리, 메모리 누수, 렌더링 최적화, 동시성 제어 등 해당 도메인의 핵심 키워드)를 사용하여 시스템에 입힌 아키텍처적 및 엔지니어링적 임팩트를 논증하십시오.
* \`improvement\`: "앞으로도 이 습관을 유지하라" 같은 조언을 원천 금지합니다. 피평가자가 적용한 기술, 프레임워크, 또는 구현 패턴의 '태생적 한계'나 '컴퓨팅 자원/유지보수 생산성 간의 트레이드오프(Trade-off)'를 예리하게 지적하고, 이를 극복하기 위해 나아가야 할 한 단계 높은 소프트웨어 아키텍처적 극복 과제를 단 한 문장으로 엄격히 기술하십시오.
* \`example\`: \`improvement\`에서 지적한 기술적 한계와 트레이드오프를 기반으로, 피평가자가 향후 코드 리뷰나 사내 기술 공유 채널(Slack, Issue 등)에서 실제 팀원들과 논의할 때 즉시 복사·붙여넣기해서 쓸 수 있는 실전 소통 템플릿(GitHub Comment / Slack Message 형태)을 구체적인 기술 키워드를 채워 직접 작성하십시오. (예: "현재 구조는 X의 한계가 있어 다음 단계로 Y 패턴 도입을 제안합니다. 코드 레벨에서는..." 과 같이 동료 엔지니어의 액션을 이끌어내는 실전 소통 양식으로 작성되어야 합니다.)

**💡 필드별 올바른 출력 예시 (이 기준에 맞추어 출력하십시오):**
{
  "code_stability": {
    "score": 4.0,
    "reason": "[[PR #194](https://github.com/${owner}/${repo}/pull/194)] 외부 의존성이 높은 SSE(Server-Sent Events) 커넥션 제어 로직에서 주기적인 하드코딩 타이머 인터벌을 외부 컨피그로 격리했습니다. 이를 통해 네트워크 타임아웃 및 재연결 오버헤드 발생 시 스레드 풀이 고갈되는 리스크를 방어하고, 인메모리 테스트 시 가상 클락을 주입할 수 있도록 결합도를 낮추어 테스트 안정성(Deterministic Test)을 확보하는 엔지니어링 임팩트를 냈습니다.",
    "improvement": "다만 현재의 컨피그 외부화는 단순 폴링 주기에 국한되어 있어, 대규모 커넥션 폭발(Thundering Herd) 발생 시 게이트웨이 및 가비지 컬렉션(GC)에 가해지는 스파이크 부하를 동적으로 제어할 수 없는 태생적 한계가 있습니다.",
    "example": "PR #194에서 SSE 타이머 인터벌을 외부화하여 1차 격리는 마쳤지만, 클라이언트 동시 접속 급증 시 게이트웨이 메모리 누수나 스파이크 부하 리스크가 여전히 남아있습니다. 이를 보완하기 위해 다음 스프린트에서는 지수 백오프(Exponential Backoff)와 지터(Jitter) 알고리즘을 클라이언트 커넥션 재시도 로직에 도입하는 방향을 제안하고 싶은데, 다들 어떻게 생각하시나요?"
  }
}
  
{
  "mutual_respect": { "reason": "string", "score": number, "improvement": "string", "example": "string" },
  "conflict_management": { "reason": "string", "score": number, "improvement": "string", "example": "string" },
  "logical_problem_definition": { "reason": "string", "score": number, "improvement": "string", "example": "string" },
  "review_guiding": { "reason": "string", "score": number, "improvement": "string", "example": "string" },
  "documentation": { "reason": "string", "score": number, "improvement": "string", "example": "string" },
  "knowledge_sharing": { "reason": "string", "score": number, "improvement": "string", "example": "string" },
  "technical_influence": { "reason": "string", "score": number, "improvement": "string", "example": "string" },
  "code_stability": { "reason": "string", "score": number, "improvement": "string", "example": "string" },
  "summary": "피평가자의 백엔드 기술 아키텍처 및 소통 역량을 종합하여 냉정하게 요약한 3줄 내외의 수석 평가위원 의견서"
}

**주의사항:**
JSON 이스케이프 규칙을 철저히 준수하세요. 문자열 내에 쌍따옴표(")가 들어갈 경우 반드시 \\" 로 이스케이프하고, 줄바꿈은 \\n으로 처리하여 유효한 JSON 포맷을 유지하십시오. 코드 블록(\`\`\`) 없이 순수 JSON 객체만 반환하세요.`;
  }

  async analyze(data: CollectedDataDto): Promise<LlmAnalysisResponse> {
    if (!this.openai) {
      throw new Error('OPENAI_API_KEY not found. LLM Analysis cannot proceed.');
    }

    const rawDataPrompt = JSON.stringify(data);
    const systemPrompt = this.buildSystemPrompt(
      data.owner,
      data.repo,
      data.targetUser,
    );
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
        // temperature: 0, // 결과의 일관성 및 재현성을 위해 0으로 설정
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
    const systemPrompt = this.buildSystemPrompt(
      data.owner,
      data.repo,
      data.targetUser,
    );
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
