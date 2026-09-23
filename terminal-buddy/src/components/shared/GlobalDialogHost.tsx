import { useSyncExternalStore } from 'react';
import { ConfirmDialog, Dialog } from './Dialog';
import { getActiveDialog, settleDialog, subscribeDialogs } from '../../services/dialog';

export function GlobalDialogHost() {
  const request = useSyncExternalStore(subscribeDialogs, getActiveDialog);
  if (!request) return null;

  if (request.kind === 'confirm') {
    return (
      <ConfirmDialog
        key={request.id}
        title={request.title}
        message={request.message}
        onClose={() => settleDialog(request.id, false)}
        onConfirm={() => settleDialog(request.id, true)}
        confirmText={request.confirmText}
        cancelText={request.cancelText}
        confirmVariant={request.danger ? 'danger' : 'primary'}
      />
    );
  }

  return (
    <Dialog
      key={request.id}
      title={request.title}
      role="alertdialog"
      className="tb-confirm-dialog"
      onClose={() => settleDialog(request.id)}
      footer={(
        <button type="button" className="btn-primary" onClick={() => settleDialog(request.id)}>
          知道了
        </button>
      )}
    >
      <div className="tb-confirm-message">{request.message}</div>
    </Dialog>
  );
}
