"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RefinerService = void 0;
const common_1 = require("@nestjs/common");
let RefinerService = class RefinerService {
    refine(data) {
        const refinedPRs = data.pullRequests.map((pr) => {
            const filteredReviews = pr.reviews.filter((review) => {
                const body = review.body.trim();
                if (body.length < 5 || /^(LGTM|good|nice|ok|approved|확인|좋습니다)/i.test(body)) {
                    return false;
                }
                return true;
            }).map(review => ({
                ...review,
                comments: review.comments.filter(comment => {
                    return comment.body.trim().length >= 5;
                })
            }));
            return {
                ...pr,
                reviews: filteredReviews,
            };
        }).filter(pr => pr.reviews.length > 0);
        return {
            ...data,
            pullRequests: refinedPRs,
        };
    }
};
exports.RefinerService = RefinerService;
exports.RefinerService = RefinerService = __decorate([
    (0, common_1.Injectable)()
], RefinerService);
//# sourceMappingURL=refiner.service.js.map