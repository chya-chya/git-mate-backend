export interface GithubInstallationAccount {
  id: number;
  login: string;
  type: string;
}

export interface GithubInstallationPayload {
  id: number;
  account: GithubInstallationAccount | null;
  repository_selection: string;
  suspended_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface GithubInstallationWebhookPayload {
  action: string;
  installation: GithubInstallationPayload;
}

export interface GithubInstallationStatePayload {
  sub: number;
  jti: string;
  purpose: 'github-app-install';
}
