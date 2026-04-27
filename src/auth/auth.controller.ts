import { Controller, Get, UseGuards, Req, Res, Post } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('github')
  @UseGuards(AuthGuard('github'))
  @ApiOperation({ summary: 'GitHub OAuth Login' })
  async githubAuth(@Req() req) {}

  @Get('github/callback')
  @UseGuards(AuthGuard('github'))
  @ApiOperation({ summary: 'GitHub OAuth Callback' })
  @ApiResponse({ status: 200, description: 'Login successful, returns tokens' })
  async githubAuthRedirect(@Req() req, @Res() res) {
    const user = await this.authService.validateUser(req.user);
    const tokens = await this.authService.login(user);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const redirectUrl = `${frontendUrl}/auth/callback?access_token=${tokens.access_token}&refresh_token=${tokens.refresh_token}&username=${user.username}`;

    res.redirect(redirectUrl);
  }

  @Post('refresh')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Refresh Access Token' })
  @ApiResponse({ status: 200, description: 'Tokens refreshed' })
  async refresh(@Req() req) {
    const userId = req.user.id;
    const refreshToken = req.headers['authorization']?.replace('Bearer ', '');
    // Note: In a real app, you might use a separate strategy for RT
    // For now, we'll extract it from the header or a dedicated field
    return this.authService.refreshTokens(userId, refreshToken);
  }
}
