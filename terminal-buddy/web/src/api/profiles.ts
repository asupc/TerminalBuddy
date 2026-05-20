import client from './client';
import type { Profile } from '../types';

export async function listProfiles(): Promise<Profile[]> {
  const { data } = await client.get('/profiles');
  return data;
}

export async function createProfile(profile: Profile): Promise<Profile> {
  const { data } = await client.post('/profiles', profile);
  return data;
}

export async function updateProfile(id: string, profile: Profile): Promise<Profile> {
  const { data } = await client.put(`/profiles/${id}`, profile);
  return data;
}

export async function deleteProfile(id: string): Promise<void> {
  await client.delete(`/profiles/${id}`);
}
