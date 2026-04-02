import { AuthService } from './auth.service';
export declare class AuthController {
    private readonly authService;
    constructor(authService: AuthService);
    githubAuth(req: any): Promise<void>;
    githubAuthRedirect(req: any, res: any): Promise<void>;
    refresh(req: any): Promise<{
        access_token: string;
        refresh_token: string;
    }>;
}
