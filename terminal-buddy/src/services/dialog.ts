export interface ConfirmOptions {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

type DialogRequest =
  | {
      id: number;
      kind: 'alert';
      title: string;
      message: string;
      resolve: () => void;
    }
  | {
      id: number;
      kind: 'confirm';
      title: string;
      message: string;
      confirmText: string;
      cancelText: string;
      danger: boolean;
      resolve: (confirmed: boolean) => void;
    };

let nextId = 1;
let requests: DialogRequest[] = [];
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach(listener => listener());
}

function enqueue(request: DialogRequest) {
  requests = [...requests, request];
  emit();
}

export function showAlert(message: unknown, title = '提示'): Promise<void> {
  return new Promise(resolve => {
    enqueue({ id: nextId++, kind: 'alert', title, message: String(message), resolve });
  });
}

export function showConfirm(message: unknown, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise(resolve => {
    enqueue({
      id: nextId++,
      kind: 'confirm',
      title: options.title ?? '确认操作',
      message: String(message),
      confirmText: options.confirmText ?? '确定',
      cancelText: options.cancelText ?? '取消',
      danger: options.danger ?? true,
      resolve,
    });
  });
}

export function subscribeDialogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getActiveDialog(): DialogRequest | null {
  return requests[0] ?? null;
}

export function settleDialog(id: number, confirmed = false) {
  const request = requests.find(item => item.id === id);
  if (!request) return;
  requests = requests.filter(item => item.id !== id);
  if (request.kind === 'alert') request.resolve();
  else request.resolve(confirmed);
  emit();
}

