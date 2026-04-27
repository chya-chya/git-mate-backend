import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { UserService } from './user.service';
import { UserResponseDto, UserTokensDto } from './dto/user.dto';

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
  async getProfile(@Req() req): Promise<UserResponseDto> {
    return this.userService.getUserProfile(req.user.id);
  }

  @Get('tokens')
  @ApiOperation({ summary: 'Get current user available tokens' })
  @ApiResponse({
    status: 200,
    description: 'Success',
    type: UserTokensDto,
  })
  async getTokens(@Req() req): Promise<UserTokensDto> {
    return this.userService.getAvailableTokens(req.user.id);
  }
}
