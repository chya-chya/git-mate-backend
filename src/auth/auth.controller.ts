import {
  Controller,
  ForbiddenException,
  Get,
  UseGuards,
  Req,
  Res,
  Post,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request, Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import type { GithubOAuthDetails } from './auth.service';
import { GithubReauthorizeUrlDto } from './dto/github-reauthorize-url.dto';
import { GithubOAuthGuard } from './guards/github-oauth.guard';

interface AuthenticatedRequest extends Request {
  user: {
    id: number;
    username: string;
  };
}

interface GithubOAuthCallbackRequest extends Request {
  user: GithubOAuthDetails;
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('github')
  @UseGuards(GithubOAuthGuard)
  @ApiOperation({ summary: 'GitHub OAuth Login or Reauthorization' })
  async githubAuth() {}

  @Get('github/reauthorize-url')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create GitHub OAuth reauthorization URL' })
  @ApiResponse({ status: 200, type: GithubReauthorizeUrlDto })
  async getGithubReauthorizeUrl(
    @Req() req: AuthenticatedRequest,
  ): Promise<GithubReauthorizeUrlDto> {
    return this.authService.createGithubReauthorizationUrl(req.user.id);
  }

  @Get('github/callback')
  @UseGuards(AuthGuard('github'))
  @ApiOperation({ summary: 'GitHub OAuth Callback' })
  @ApiResponse({ status: 200, description: 'Login successful, returns tokens' })
  async githubAuthRedirect(
    @Req() req: GithubOAuthCallbackRequest,
    @Res() res: Response,
  ) {
    const user = await this.authService.completeGithubOAuth(
      req.user,
      req.query?.state,
    );
    const tokens = await this.authService.login(user);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const redirectUrl = `${frontendUrl}/auth/callback?access_token=${tokens.access_token}&refresh_token=${tokens.refresh_token}&username=${user.username}`;

    return res.redirect(redirectUrl);
  }

  @Post('refresh')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Refresh Access Token' })
  @ApiResponse({ status: 200, description: 'Tokens refreshed' })
  async refresh(@Req() req: AuthenticatedRequest) {
    const userId = req.user.id;
    const refreshToken = req.headers['authorization']?.replace('Bearer ', '');

    if (!refreshToken) {
      throw new ForbiddenException('Access Denied');
    }

    // Note: In a real app, you might use a separate strategy for RT
    // For now, we'll extract it from the header or a dedicated field
    return this.authService.refreshTokens(userId, refreshToken);
  }
}
