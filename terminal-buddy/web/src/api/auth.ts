import client from './client';

export async function login(username: string, password: string): Promise<{ token: string; username: string }> {
  const { data } = await client.post('/auth/login', { username, password });
  return data;
}

export async function getApiStatus(): Promise<{ enabled: boolean; port: number }> {
  const { data } = await client.get('/auth/status');
  return data;
}
