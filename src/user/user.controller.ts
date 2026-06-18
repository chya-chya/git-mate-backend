import { Controller, Get, UseGuards, Req, Post } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { UserService } from './user.service';
import {
  DeactivateUserResponseDto,
  UserResponseDto,
  UserTokensDto,
} from './dto/user.dto';

interface AuthenticatedRequest extends Request {
  user: {
    id: number;
    username: string;
  };
}

@ApiTags('User')
@Controller('user')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('profile')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({
    status: 200,
    description: 'Success',
    type: UserResponseDto,
  })
  async getProfile(@Req() req: AuthenticatedRequest): Promise<UserResponseDto> {
    return this.userService.getUserProfile(req.user.id);
  }

  @Get('tokens')
  @ApiOperation({ summary: 'Get current user available tokens' })
  @ApiResponse({
    status: 200,
    description: 'Success',
    type: UserTokensDto,
  })
  async getTokens(@Req() req: AuthenticatedRequest): Promise<UserTokensDto> {
    return this.userService.getAvailableTokens(req.user.id);
  }

  @Post('deactivate')
  @ApiOperation({ summary: 'Deactivate current authenticated user account' })
  @ApiResponse({
    status: 200,
    description: 'Account deactivated',
    type: DeactivateUserResponseDto,
  })
  async deactivate(
    @Req() req: AuthenticatedRequest,
  ): Promise<DeactivateUserResponseDto> {
    return this.userService.deactivateUser(req.user.id);
  }
}
