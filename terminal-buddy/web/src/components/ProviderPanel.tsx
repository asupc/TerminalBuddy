import type { ReactNode } from 'react';
import { Dialog } from './Dialog';
import '../screens/Projects.css';
import './ProviderPanel.css';

export function ProviderPanel({ title, children, footer, onClose }: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  onClose?: () => void;
}) {
  if (onClose) {
    return (
      <Dialog title={title} className="project-editor-dialog" onClose={onClose} footer={footer}>
        {children}
      </Dialog>
    );
  }
  return (
    <section className="provider-panel" aria-label={title}>
      <h3>{title}</h3>
      {children}
      <div className="provider-panel-actions">{footer}</div>
    </section>
  );
}
