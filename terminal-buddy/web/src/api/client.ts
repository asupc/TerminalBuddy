import axios from 'axios';
import { useWebAppStore } from '../stores/appStore';

const client = axios.create({
  baseURL: '/api',
  timeout: 10000,
});

client.interceptors.request.use((config) => {
  const token = useWebAppStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      useWebAppStore.getState().logout();
    }
    return Promise.reject(error);
  }
);

export default client;
