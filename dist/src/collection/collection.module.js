"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CollectionModule = void 0;
const common_1 = require("@nestjs/common");
const collection_service_1 = require("./collection.service");
const github_provider_1 = require("./github.provider");
const prisma_module_1 = require("../prisma/prisma.module");
const config_1 = require("@nestjs/config");
const auth_module_1 = require("../auth/auth.module");
const analysis_module_1 = require("../analysis/analysis.module");
const collection_controller_1 = require("./collection.controller");
let CollectionModule = class CollectionModule {
};
exports.CollectionModule = CollectionModule;
exports.CollectionModule = CollectionModule = __decorate([
    (0, common_1.Module)({
        imports: [prisma_module_1.PrismaModule, config_1.ConfigModule, auth_module_1.AuthModule, analysis_module_1.AnalysisModule],
        providers: [collection_service_1.CollectionService, github_provider_1.GithubProvider],
        controllers: [collection_controller_1.CollectionController],
        exports: [collection_service_1.CollectionService],
    })
], CollectionModule);
//# sourceMappingURL=collection.module.js.map