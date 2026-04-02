import { Module } from '@nestjs/common';
import { CollectionService } from './collection.service';
import { GithubProvider } from './github.provider';
import { PrismaModule } from '../prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { AnalysisModule } from '../analysis/analysis.module';

import { CollectionController } from './collection.controller';

@Module({
  imports: [PrismaModule, ConfigModule, AuthModule, AnalysisModule],
  providers: [CollectionService, GithubProvider],
  controllers: [CollectionController],
  exports: [CollectionService],
})
export class CollectionModule {}
