import { invoke } from '@tauri-apps/api/core';

export interface UpdateInfo {
  version: string;
  releaseDate: string;
  changelogMd: string;
  downloadUrl: string;
  mandatory: boolean;
}

export async function checkAppUpdate(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>('check_app_update');
}
