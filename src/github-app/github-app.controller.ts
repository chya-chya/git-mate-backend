import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  GithubAppCallbackQueryDto,
  GithubAppConnectionStatusDto,
  GithubAppInstallUrlDto,
  GithubInstallationDto,
} from './dto/github-app.dto';
import { GithubAppService } from './github-app.service';

interface AuthenticatedRequest extends Request {
  user: { id: number; username: string };
}

@ApiTags('GitHub App')
@Controller('github-app/installations')
export class GithubAppController {
  constructor(private readonly githubAppService: GithubAppService) {}

  @Get('install-url')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a signed GitHub App installation URL' })
  @ApiResponse({ status: 200, type: GithubAppInstallUrlDto })
  getInstallUrl(
    @Req() request: AuthenticatedRequest,
  ): Promise<GithubAppInstallUrlDto> {
    return this.githubAppService.createInstallUrl(request.user.id);
  }

  @Get('status')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get login and GitHub App connection status' })
  @ApiResponse({ status: 200, type: GithubAppConnectionStatusDto })
  getConnectionStatus(
    @Req() request: AuthenticatedRequest,
  ): Promise<GithubAppConnectionStatusDto> {
    return this.githubAppService.getConnectionStatus(request.user.id);
  }

  @Get('callback')
  @ApiOperation({ summary: 'Complete a GitHub App installation' })
  async callback(
    @Query() query: GithubAppCallbackQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    const redirectUrl = await this.githubAppService.completeInstallation(
      query.installation_id,
      query.state,
      query.setup_action,
    );
    response.redirect(redirectUrl);
  }

  @Get()
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get accessible GitHub App installations' })
  @ApiResponse({ status: 200, type: [GithubInstallationDto] })
  getInstallations(
    @Req() request: AuthenticatedRequest,
  ): Promise<GithubInstallationDto[]> {
    return this.githubAppService.getInstallations(request.user.id);
  }
}
