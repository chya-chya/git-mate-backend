import { ConfigService } from '@nestjs/config';
import { getEncoding } from 'js-tiktoken';
import { CollectedDataDto } from '../../collection/types/github-api.types';
import {
  InvalidLlmProviderResponseError,
  LlmProviderService,
  LlmTokenEstimationError,
} from '../llm-provider.service';

jest.mock('js-tiktoken', () => ({
  getEncoding: jest.fn(() => ({
    encode: (value: string) => Array.from(value),
  })),
}));

describe('LlmProviderService billing metadata', () => {
  const data = {
    owner: 'owner',
    repo: 'repository',
    targetUser: 'developer',
  } as unknown as CollectedDataDto;

  function createService(providerResponse?: unknown) {
    const service = new LlmProviderService({
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService);
    const create = jest.fn().mockResolvedValue(providerResponse);
    Object.defineProperty(service, 'openai', {
      configurable: true,
      value: { chat: { completions: { create } } },
    });
    return { create, service };
  }

  it('rejects a billed response when provider usage is missing', async () => {
    const { service } = createService({
      id: 'chatcmpl_missing_usage',
      choices: [{ message: { content: '{}' } }],
    });

    await expect(service.analyze(data)).rejects.toMatchObject({
      name: InvalidLlmProviderResponseError.name,
      providerRequestId: 'chatcmpl_missing_usage',
    });
  });

  it('returns the actual provider request ID with validated usage', async () => {
    const { service } = createService({
      id: 'chatcmpl_actual_123',
      choices: [{ message: { content: '{}' } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });

    await expect(service.analyze(data)).resolves.toMatchObject({
      providerRequestId: 'chatcmpl_actual_123',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  });

  it('stops before reservation when prompt token encoding fails', () => {
    jest.mocked(getEncoding).mockImplementationOnce(() => {
      throw new Error('encoder unavailable');
    });
    const { create, service } = createService();

    expect(() => service.estimateTokenReservationForData(data)).toThrow(
      LlmTokenEstimationError,
    );
    expect(create).not.toHaveBeenCalled();
  });
});
