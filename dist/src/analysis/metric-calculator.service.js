"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetricCalculatorService = void 0;
const common_1 = require("@nestjs/common");
let MetricCalculatorService = class MetricCalculatorService {
    calculate(llmResult) {
        return {
            actionableScore: llmResult.actionable_score,
            feedbackAcceptScore: this.mapAcceptanceToScore(llmResult.feedback_acceptance),
            avgCycleTimeHours: llmResult.conflict_resolution_time_hours,
            logicScore: llmResult.tech_domains.business_logic,
            architectureScore: llmResult.tech_domains.architecture,
            dbScore: llmResult.tech_domains.database,
            infraScore: llmResult.tech_domains.infrastructure,
        };
    }
    mapAcceptanceToScore(acceptance) {
        const map = {
            '수용적': 100,
            '수용': 100,
            '보통': 50,
            '방어적': 20,
            '거부': 10,
        };
        return map[acceptance] || 50;
    }
};
exports.MetricCalculatorService = MetricCalculatorService;
exports.MetricCalculatorService = MetricCalculatorService = __decorate([
    (0, common_1.Injectable)()
], MetricCalculatorService);
//# sourceMappingURL=metric-calculator.service.js.map