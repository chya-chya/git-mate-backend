import { CollectionService } from './collection.service';
import { CollectedDataDto } from './types/github-api.types';
export declare class CollectionController {
    private readonly collectionService;
    constructor(collectionService: CollectionService);
    sync(githubRepoId: string, req: any): Promise<CollectedDataDto>;
    getRepositories(req: any): Promise<any[]>;
}
