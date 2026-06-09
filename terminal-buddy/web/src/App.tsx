import { useWebAppStore } from './stores/appStore';
import LoginPage from './components/LoginPage';
import MainLayout from './components/MainLayout';

function App() {
  const token = useWebAppStore((s) => s.token);

  if (!token) {
    return <LoginPage />;
  }

  return <MainLayout />;
}

export default App;
