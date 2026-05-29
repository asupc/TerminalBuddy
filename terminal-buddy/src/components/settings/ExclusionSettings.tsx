import { FC, useState } from 'react';
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

  return (
    <div className="settings-general">
      <p className="settings-desc">配置文件导航中需要屏蔽的文件和文件夹规则</p>
      <div className="exclusion-list">
        {exclusionPatterns.map((pattern, idx) => (
          <div key={idx} className="cmd-cat-item" onContextMenu={(e) => {
            e.preventDefault();
            setExclusionContextMenu({ x: e.clientX, y: e.clientY, idx });
          }}>
            <code className="cmd-cat-cmd">{pattern}</code>
            <span className="cmd-cat-desc">
              {pattern.startsWith('*.') ? '匹配后缀' : pattern.startsWith('**/') ? '匹配扩展名' : '精确匹配名称'}
            </span>
            <div className="cmd-cat-actions">
              <button
                className="cmd-action-btn danger"
                title="删除"
                onClick={() => {
                  askConfirm(`确定删除排除规则「${pattern}」？`, () => {
                    setConfirmDialog(null);
                    setExclusionPatterns(exclusionPatterns.filter((_, i) => i !== idx));
                  });
                }}
              >×</button>
            </div>
          </div>
        ))}
      </div>
      <div className="cmd-add-form">
        <input
          placeholder="例: node_modules, *.log, **/*.html"
          value={newPattern}
          onChange={(e) => setNewPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newPattern.trim()) {
              setExclusionPatterns([...exclusionPatterns, newPattern.trim()]);
              setNewPattern('');
            }
          }}
        />
        <button className="btn-primary" onClick={() => {
          if (newPattern.trim()) {
            setExclusionPatterns([...exclusionPatterns, newPattern.trim()]);
            setNewPattern('');
          }
        }}>添加</button>
      </div>
      <button
        className="btn-secondary"
        style={{ marginTop: 8, alignSelf: 'flex-start' }}
        onClick={() => {
          askConfirm('确定重置排除规则为默认？当前规则将被覆盖。', () => {
            setConfirmDialog(null);
            setExclusionPatterns(['node_modules', '.git']);
          });
        }}
      >重置为默认</button>
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
