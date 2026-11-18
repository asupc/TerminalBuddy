import { FC, useState } from 'react';
import { FileX2, Plus, RotateCcw } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';

interface ExclusionSettingsProps {
  askConfirm: (message: string, onConfirm: () => void) => void;
  setConfirmDialog: (v: null) => void;
}

export const ExclusionSettings: FC<ExclusionSettingsProps> = ({ askConfirm, setConfirmDialog }) => {
  const exclusionPatterns = useAppStore(s => s.exclusionPatterns);
  const setExclusionPatterns = useAppStore(s => s.setExclusionPatterns);
  const [newPattern, setNewPattern] = useState('');
  const [exclusionContextMenu, setExclusionContextMenu] = useState<{ x: number; y: number; idx: number } | null>(null);

  const addPattern = () => {
    const trimmed = newPattern.trim();
    if (!trimmed) return;
    setExclusionPatterns([...exclusionPatterns, trimmed]);
    setNewPattern('');
  };

  return (
    <div className="settings-general">
      <div className="settings-card-group">
        <div className="card-group-header">
          <span className="card-group-title">
            <FileX2 size={14} aria-hidden="true" />
            已启用规则
          </span>
          <div className="card-group-header-actions">
            <span className="card-group-extra">支持精确名称、*.ext 与 **/*.ext</span>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => {
                askConfirm('确定重置排除规则为默认？当前规则将被覆盖。', () => {
                  setConfirmDialog(null);
                  setExclusionPatterns(['node_modules', '.git']);
                });
              }}
            >
              <RotateCcw size={13} aria-hidden="true" />
              重置为默认
            </button>
          </div>
        </div>

        <div className="rule-list">
          {exclusionPatterns.length === 0 ? (
            <div className="settings-empty-state">暂无排除规则，可在下方输入框添加</div>
          ) : (
            exclusionPatterns.map((pattern, idx) => (
              <div
                key={`${pattern}-${idx}`}
                className="rule-row"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setExclusionContextMenu({ x: e.clientX, y: e.clientY, idx });
                }}
              >
                <div className="rule-row-left">
                  <code className="rule-code">{pattern}</code>
                  <span className="settings-row-desc">
                    {pattern.startsWith('*.')
                      ? '匹配后缀名'
                      : pattern.startsWith('**/')
                        ? '匹配任意路径下的扩展名'
                        : '精确匹配目录或文件名'}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn-danger-outline btn-sm"
                  title="移除"
                  onClick={() => {
                    askConfirm(`确定删除排除规则「${pattern}」？`, () => {
                      setConfirmDialog(null);
                      setExclusionPatterns(exclusionPatterns.filter((_, i) => i !== idx));
                    });
                  }}
                  aria-label={`删除排除规则 ${pattern}`}
                >
                  移除
                </button>
              </div>
            ))
          )}
        </div>

        <div className="card-group-footer">
          <input
            className="tb-input mono"
            placeholder="输入新规则，例如 target、dist、*.log、**/*.map"
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addPattern();
            }}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={!newPattern.trim()}
            onClick={addPattern}
          >
            <Plus size={15} aria-hidden="true" />
            添加规则
          </button>
        </div>
      </div>

      {exclusionContextMenu && (
        <div className="context-menu-overlay" onClick={() => setExclusionContextMenu(null)} />
      )}
      {exclusionContextMenu && (
        <div className="context-menu" style={{ left: exclusionContextMenu.x, top: exclusionContextMenu.y }}>
          <div className="context-menu-item danger" onClick={() => {
            const idx = exclusionContextMenu.idx;
            const pattern = exclusionPatterns[idx];
            setExclusionContextMenu(null);
            askConfirm(`确定删除排除规则「${pattern}」？`, () => {
              setConfirmDialog(null);
              setExclusionPatterns(exclusionPatterns.filter((_, i) => i !== idx));
            });
          }}>删除</div>
        </div>
      )}
    </div>
  );
};
