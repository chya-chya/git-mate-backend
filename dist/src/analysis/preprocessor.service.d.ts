import { CollectedDataDto } from '../collection/types/github-api.types';
export declare class PreprocessorService {
    preprocess(data: CollectedDataDto): CollectedDataDto;
    private cleanText;
}
