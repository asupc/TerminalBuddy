import { useStore } from './store';
import Login from './screens/Login';
import Nav from './screens/Nav';
import Terminal from './screens/Terminal';

export default function App() {
  const token = useStore((s) => s.token);
  const view = useStore((s) => s.view);

  if (!token) return <Login />;
  if (view.screen === 'terminal') {
    return (
      <Terminal
        terminalId={view.terminalId}
        profileName={view.profileName}
        owner={view.owner}
      />
    );
  }
  return <Nav />;
}
