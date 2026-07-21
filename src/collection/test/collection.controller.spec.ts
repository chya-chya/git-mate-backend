import { PATH_METADATA } from '@nestjs/common/constants';
import { CollectionController } from '../collection.controller';
import { CollectionService } from '../collection.service';

describe('CollectionController', () => {
  const collectionService = {
    estimateCost: jest.fn(),
  };
  const controller = new CollectionController(
    collectionService as unknown as CollectionService,
  );
  const request = {
    user: { id: 7 },
  } as Parameters<CollectionController['estimateCost']>[1];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('serves the cost estimate from the new endpoint', async () => {
    const response = { prCount: 3, estimatedTokens: 1200 };
    collectionService.estimateCost.mockResolvedValue(response);

    await expect(controller.estimateCost('repo-1', request)).resolves.toEqual(
      response,
    );
    expect(collectionService.estimateCost).toHaveBeenCalledWith('repo-1', 7);
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        // eslint-disable-next-line @typescript-eslint/unbound-method
        CollectionController.prototype.estimateCost,
      ),
    ).toBe('estimate-cost/:githubRepoId');
  });

  it('keeps the legacy endpoint response contract', async () => {
    const response = { prCount: 3, estimatedTokens: 1200 };
    collectionService.estimateCost.mockResolvedValue(response);

    await expect(controller.estimate('repo-1', request)).resolves.toEqual(
      response,
    );
    expect(collectionService.estimateCost).toHaveBeenCalledWith('repo-1', 7);
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        // eslint-disable-next-line @typescript-eslint/unbound-method
        CollectionController.prototype.estimate,
      ),
    ).toBe('estimate/:githubRepoId');
  });
});
