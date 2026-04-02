"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PreprocessorService = void 0;
const common_1 = require("@nestjs/common");
let PreprocessorService = class PreprocessorService {
    preprocess(data) {
        return {
            ...data,
            pullRequests: data.pullRequests.map((pr) => ({
                ...pr,
                body: this.cleanText(pr.body),
                reviews: pr.reviews.map((review) => ({
                    ...review,
                    body: this.cleanText(review.body),
                    comments: review.comments.map((comment) => ({
                        ...comment,
                        body: this.cleanText(comment.body),
                    })),
                })),
            })),
        };
    }
    cleanText(text) {
        if (!text)
            return '';
        let cleaned = text
            .replace(/!\[.*?\]\(.*?\)/g, '')
            .replace(/<[^>]*>?/gm, '')
            .split('```')
            .map((part, index) => {
            if (index % 2 === 1) {
                const lines = part.split('\n');
                if (lines.length > 50) {
                    return lines.slice(0, 50).join('\n') + '\n... (truncated for analysis)';
                }
            }
            return part;
        })
            .join('```');
        cleaned = cleaned
            .replace(/[\w\.-]+@[\w\.-]+\.\w{2,4}/g, '***@***.***')
            .replace(/(xox[p|b|o|r]-[0-9]{12}-[0-9]{12}-[0-9]{12}-[a-z0-9]{32})/gi, '[REDACTED_API_KEY]');
        return cleaned.trim();
    }
};
exports.PreprocessorService = PreprocessorService;
exports.PreprocessorService = PreprocessorService = __decorate([
    (0, common_1.Injectable)()
], PreprocessorService);
//# sourceMappingURL=preprocessor.service.js.map