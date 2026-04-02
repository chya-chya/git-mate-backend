"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CollectedDataDto = exports.PullRequestDto = exports.ReviewDto = exports.ReviewCommentDto = void 0;
const swagger_1 = require("@nestjs/swagger");
class ReviewCommentDto {
    author;
    body;
    createdAt;
}
exports.ReviewCommentDto = ReviewCommentDto;
__decorate([
    (0, swagger_1.ApiProperty)(),
    __metadata("design:type", String)
], ReviewCommentDto.prototype, "author", void 0);
__decorate([
    (0, swagger_1.ApiProperty)(),
    __metadata("design:type", String)
], ReviewCommentDto.prototype, "body", void 0);
__decorate([
    (0, swagger_1.ApiProperty)(),
    __metadata("design:type", String)
], ReviewCommentDto.prototype, "createdAt", void 0);
class ReviewDto {
    author;
    body;
    state;
    comments;
}
exports.ReviewDto = ReviewDto;
__decorate([
    (0, swagger_1.ApiProperty)(),
    __metadata("design:type", String)
], ReviewDto.prototype, "author", void 0);
__decorate([
    (0, swagger_1.ApiProperty)(),
    __metadata("design:type", String)
], ReviewDto.prototype, "body", void 0);
__decorate([
    (0, swagger_1.ApiProperty)(),
    __metadata("design:type", String)
], ReviewDto.prototype, "state", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ type: [ReviewCommentDto] }),
    __metadata("design:type", Array)
], ReviewDto.prototype, "comments", void 0);
class PullRequestDto {
    number;
    title;
    body;
    author;
    updatedAt;
    reviews;
}
exports.PullRequestDto = PullRequestDto;
__decorate([
    (0, swagger_1.ApiProperty)(),
    __metadata("design:type", Number)
], PullRequestDto.prototype, "number", void 0);
__decorate([
    (0, swagger_1.ApiProperty)(),
    __metadata("design:type", String)
], PullRequestDto.prototype, "title", void 0);
__decorate([
    (0, swagger_1.ApiProperty)(),
    __metadata("design:type", String)
], PullRequestDto.prototype, "body", void 0);
__decorate([
    (0, swagger_1.ApiProperty)(),
    __metadata("design:type", String)
], PullRequestDto.prototype, "author", void 0);
__decorate([
    (0, swagger_1.ApiProperty)(),
    __metadata("design:type", String)
], PullRequestDto.prototype, "updatedAt", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ type: [ReviewDto] }),
    __metadata("design:type", Array)
], PullRequestDto.prototype, "reviews", void 0);
class CollectedDataDto {
    githubRepoId;
    pullRequests;
}
exports.CollectedDataDto = CollectedDataDto;
__decorate([
    (0, swagger_1.ApiProperty)(),
    __metadata("design:type", String)
], CollectedDataDto.prototype, "githubRepoId", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ type: [PullRequestDto] }),
    __metadata("design:type", Array)
], CollectedDataDto.prototype, "pullRequests", void 0);
//# sourceMappingURL=github-api.types.js.map