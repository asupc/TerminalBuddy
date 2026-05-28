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
      const alreadyLoggedOut = !useWebAppStore.getState().token;
      if (!alreadyLoggedOut) {
        useWebAppStore.getState().logout();
        if (window.location.pathname !== '/login') {
          alert('登录已过期，请重新登录');
        }
      }
    }
    return Promise.reject(error);
  }
);

export default client;
