import { Module } from '@nestjs/common';
import { CollectionService } from './collection.service';
import { GithubProvider } from './github.provider';
import { PrismaModule } from '../prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { GithubAppModule } from '../github-app/github-app.module';

import { CollectionController } from './collection.controller';
import { RepositoryCollectionService } from './repository-collection.service';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    AuthModule,
    AnalysisModule,
    GithubAppModule,
  ],
  providers: [CollectionService, GithubProvider, RepositoryCollectionService],
  controllers: [CollectionController],
  exports: [CollectionService, RepositoryCollectionService],
})
export class CollectionModule {}
