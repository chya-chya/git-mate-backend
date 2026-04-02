import { AnalysisService } from './analysis.service';
export declare class AnalysisController {
    private readonly analysisService;
    constructor(analysisService: AnalysisService);
    getStats(req: any): Promise<any>;
    getReports(req: any): Promise<any>;
    getReport(id: string, req: any): Promise<any>;
}
