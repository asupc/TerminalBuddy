import { invoke } from '../remoteWorkspace/core';

export interface AntigravityAccountView {
  id: string;
  alias: string;
  email: string;
  name: string;
  picture: string;
  authSource: string;
  hasRefreshToken: boolean;
  tokenHint: string;
  updatedAt: string;
  isDefault: boolean;
}

export interface AntigravityAccountState {
  accounts: AntigravityAccountView[];
  activeAccountId: string | null;
}

export interface AntigravityTokenInput {
  id?: string;
  alias?: string;
  token?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface AntigravityOAuthStartResult {
  loginId: string;
  authUrl: string;
}

export interface AntigravityOAuthCompleteInput {
  loginId: string;
  code: string;
  alias?: string;
}

export function getAntigravityAccountState(): Promise<AntigravityAccountState> {
  return invoke('get_antigravity_account_state');
}

export function saveAntigravityAccountToken(
  input: AntigravityTokenInput,
): Promise<AntigravityAccountState> {
  return invoke('save_antigravity_account_token', { input });
}

export function importLocalAntigravityAccount(): Promise<AntigravityAccountState> {
  return invoke('import_local_antigravity_account');
}

export function setDefaultAntigravityAccount(
  id: string | null,
): Promise<AntigravityAccountState> {
  return invoke('set_default_antigravity_account', { id });
}

export function renameAntigravityAccount(
  id: string,
  alias: string,
): Promise<AntigravityAccountState> {
  return invoke('rename_antigravity_account', { id, alias });
}

export function deleteAntigravityAccount(
  id: string,
): Promise<AntigravityAccountState> {
  return invoke('delete_antigravity_account', { id });
}

export function startAntigravityOAuthLogin(): Promise<AntigravityOAuthStartResult> {
  return invoke('start_antigravity_oauth_login');
}

export function completeAntigravityOAuthLogin(
  input: AntigravityOAuthCompleteInput,
): Promise<AntigravityAccountState> {
  return invoke('complete_antigravity_oauth_login', { input });
}

export function cancelAntigravityOAuthLogin(loginId: string): Promise<void> {
  return invoke('cancel_antigravity_oauth_login', { loginId });
}

export interface AntigravityQuotaWindow {
  label: string;
  remainingPercent: number | null;
  resetText: string | null;
}

export interface AntigravityQuotaSummary {
  accountId: string | null;
  geminiPercent: number | null;
  geminiWindows: AntigravityQuotaWindow[];
  rawSummary: string | null;
  fetchedAt: number;
}

export function getAntigravityAccountQuota(
  accountId: string | null,
  forceRefresh = false,
): Promise<AntigravityQuotaSummary> {
  return invoke('get_antigravity_account_quota', { accountId, forceRefresh });
}
