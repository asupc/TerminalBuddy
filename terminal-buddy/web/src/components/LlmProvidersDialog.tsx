import { LlmProvidersPanel } from './LlmProvidersPanel';

export function LlmProvidersDialog(props: {
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  return <LlmProvidersPanel {...props} />;
}
