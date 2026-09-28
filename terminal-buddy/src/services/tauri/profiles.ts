import { invoke } from '@tauri-apps/api/core';
import type { Profile, Project } from '../../types';

// Profile Commands
export async function getAllProfiles(): Promise<Profile[]> {
  return invoke('get_all_profiles');
}

export async function getProfile(id: string): Promise<Profile> {
  return invoke('get_profile', { id });
}

export async function createProfile(
  name: string,
  group: string,
  terminalType: 'powershell' | 'pwsh' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'editor' | 'mstsc'
): Promise<Profile> {
  return invoke('create_profile', { name, group, terminalType });
}

export async function updateProfile(profile: Profile): Promise<void> {
  return invoke('update_profile', { profile });
}

export async function deleteProfile(id: string): Promise<void> {
  return invoke('delete_profile', { id });
}

export async function updateProfileLastUsed(id: string): Promise<void> {
  return invoke('update_profile_last_used', { id });
}

export async function getProjects(): Promise<Project[]> {
  return invoke('get_projects');
}

export async function saveProjects(projects: Project[]): Promise<void> {
  return invoke('save_projects', { projects });
}
