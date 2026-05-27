import { FC, useState, useMemo } from 'react';

interface ChmodDialogProps {
  path: string;
  currentMode: number;
  onConfirm: (mode: number) => void;
  onClose: () => void;
}

const PERM_LABELS = ['读取', '写入', '执行'];
const PERM_BITS = [4, 2, 1]; // r, w, x

function modeToBooleans(mode: number): boolean[][] {
  return [
    [!!(mode & 0o400), !!(mode & 0o200), !!(mode & 0o100)], // owner
    [!!(mode & 0o040), !!(mode & 0o020), !!(mode & 0o010)], // group
    [!!(mode & 0o004), !!(mode & 0o002), !!(mode & 0o001)], // other
  ];
}

function booleansToMode(grid: boolean[][]): number {
  let mode = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (grid[i][j]) mode |= PERM_BITS[j] << (2 - i) * 3;
    }
  }
  return mode;
}

function formatPermissionString(mode: number): string {
  const perms = [
    mode & 0o400 ? 'r' : '-',
    mode & 0o200 ? 'w' : '-',
    mode & 0o100 ? 'x' : '-',
    mode & 0o040 ? 'r' : '-',
    mode & 0o020 ? 'w' : '-',
    mode & 0o010 ? 'x' : '-',
    mode & 0o004 ? 'r' : '-',
    mode & 0o002 ? 'w' : '-',
    mode & 0o001 ? 'x' : '-',
  ];
  return '-' + perms.join('');
}

export const ChmodDialog: FC<ChmodDialogProps> = ({ path, currentMode, onConfirm, onClose }) => {
  const [grid, setGrid] = useState<boolean[][]>(() => modeToBooleans(currentMode));

  const mode = useMemo(() => booleansToMode(grid), [grid]);
  const octal = mode.toString(8).padStart(3, '0');
  const permStr = formatPermissionString(mode);

  const toggle = (row: number, col: number) => {
    setGrid(prev => {
      const next = prev.map(r => [...r]);
      next[row][col] = !next[row][col];
      return next;
    });
  };

  const fileName = path.split('/').pop() || path;

  return (
    <div className="confirm-dialog-overlay" onClick={onClose}>
      <div className="confirm-dialog" style={{ width: 320 }} onClick={e => e.stopPropagation()}>
        <div className="confirm-dialog-title">修改权限 - {fileName}</div>
        <div style={{ margin: '12px 0' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '60px 60px 60px 60px', gap: 2, marginBottom: 8 }}>
            <span />
            {PERM_LABELS.map(label => (
              <span key={label} style={{ fontSize: 11, color: 'var(--text-secondary)', textAlign: 'center' }}>{label}</span>
            ))}
            {['所有者', '组', '其他'].map((label, row) => (
              <>
                <span key={`label-${row}`} style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' }}>{label}</span>
                {grid[row].map((checked, col) => (
                  <div key={`${row}-${col}`} style={{ display: 'flex', justifyContent: 'center' }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(row, col)}
                      style={{ cursor: 'pointer' }}
                    />
                  </div>
                ))}
              </>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, fontSize: 13, color: 'var(--text-primary)' }}>
            <span>权限: <code style={{ background: 'var(--bg-tertiary)', padding: '1px 4px', borderRadius: 2 }}>{permStr}</code></span>
            <span>八进制: <code style={{ background: 'var(--bg-tertiary)', padding: '1px 4px', borderRadius: 2 }}>{octal}</code></span>
          </div>
        </div>
        <div className="confirm-dialog-buttons">
          <button className="btn-secondary" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={() => onConfirm(mode)}>确定</button>
        </div>
      </div>
    </div>
  );
};
