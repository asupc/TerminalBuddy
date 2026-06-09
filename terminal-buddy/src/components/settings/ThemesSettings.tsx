import { FC, useState, useEffect } from 'react';
import { getAllThemes, createTheme, updateTheme, deleteTheme } from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { PRESET_THEMES, type CustomTheme } from '../../types';

export const ThemesSettings: FC = () => {
  const customThemes = useAppStore(s => s.customThemes);
  const setCustomThemes = useAppStore(s => s.setCustomThemes);
  const [allThemes, setAllThemes] = useState<Array<typeof PRESET_THEMES[0] | CustomTheme>>([]);
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [editingTheme, setEditingTheme] = useState<CustomTheme | null>(null);

  useEffect(() => {
    setAllThemes([...PRESET_THEMES, ...customThemes]);
  }, [customThemes]);

  useEffect(() => {
    getAllThemes().then(setCustomThemes).catch(console.error);
  }, []);

  const handleCreateTheme = async () => {
    try {
      const saved = await createTheme(`自定义 ${customThemes.length + 1}`);
      setCustomThemes([...customThemes, saved]);
      setSelectedThemeId(saved.id);
      setEditingTheme(saved);
    } catch (err) {
      alert('创建主题失败: ' + String(err));
    }
  };

  const handleSaveTheme = async () => {
    if (!editingTheme) return;
    try {
      await updateTheme(editingTheme);
      setCustomThemes(customThemes.map(t => t.id === editingTheme.id ? editingTheme : t));
      setEditingTheme(null);
    } catch (err) {
      alert('保存主题失败: ' + String(err));
    }
  };

  const handleDeleteTheme = async (id: string) => {
    try {
      await deleteTheme(id);
      setCustomThemes(customThemes.filter(t => t.id !== id));
      if (selectedThemeId === id) {
        setSelectedThemeId(null);
        setEditingTheme(null);
      }
    } catch (err) {
      alert('删除主题失败: ' + String(err));
    }
  };

  const handleColorChange = (field: keyof CustomTheme, value: string) => {
    if (!editingTheme) return;
    setEditingTheme({ ...editingTheme, [field]: value });
  };

  return (
    <div className="theme-manager">
      <div className="theme-list">
        {allThemes.map((t) => {
          const isCustom = 'cursor' in t;
          return (
            <div
              key={t.id}
              className={`theme-card ${selectedThemeId === t.id ? 'active' : ''}`}
              onClick={() => {
                setSelectedThemeId(t.id);
                if (isCustom && !editingTheme) setEditingTheme(t as CustomTheme);
              }}
            >
              <div className="theme-swatch" style={{ background: t.background }} />
              <span className="theme-card-name">{t.name}</span>
              {isCustom ? (
                <span className="theme-badge custom">自定义</span>
              ) : (
                <span className="theme-badge preset">预设</span>
              )}
              {isCustom && editingTheme?.id !== t.id && (
                <button
                  className="theme-card-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteTheme(t.id);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        <button className="theme-create-btn" onClick={handleCreateTheme}>
          + 新建主题
        </button>
      </div>

      {editingTheme && (
        <div className="theme-editor">
          <div className="theme-editor-header">
            <input
              className="theme-editor-name"
              value={editingTheme.name}
              onChange={(e) => handleColorChange('name', e.target.value)}
            />
            <div className="theme-editor-actions">
              <button className="btn-primary" onClick={handleSaveTheme}>保存</button>
              <button className="btn-secondary" onClick={() => setEditingTheme(null)}>取消</button>
            </div>
          </div>
          <div className="color-slots">
            {([
              ['background', '背景'],
              ['foreground', '前景'],
              ['cursor', '光标'],
              ['black', '黑色'],
              ['red', '红色'],
              ['green', '绿色'],
              ['yellow', '黄色'],
              ['blue', '蓝色'],
              ['magenta', '品红'],
              ['cyan', '青色'],
              ['white', '白色'],
            ] as [keyof CustomTheme, string][]).map(([field, label]) => (
              <div key={field} className="color-slot">
                <label>{label}</label>
                <div className="color-input-wrap">
                  <input
                    type="color"
                    value={editingTheme[field] as string}
                    onChange={(e) => handleColorChange(field, e.target.value)}
                  />
                  <input
                    type="text"
                    value={editingTheme[field] as string}
                    onChange={(e) => handleColorChange(field, e.target.value)}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="theme-preview" style={{ background: editingTheme.background, color: editingTheme.foreground }}>
            <div>PS C:\Projects&gt; <span style={{ color: editingTheme.green }}>npm run dev</span></div>
            <div style={{ color: editingTheme.cyan }}>  VITE v5.2.0  ready in 312 ms</div>
            <div style={{ color: editingTheme.foreground }}>  ➜  Local:   http://localhost:1420/</div>
            <div>PS C:\Projects&gt;<span style={{ background: editingTheme.cursor }}> </span></div>
          </div>
        </div>
      )}
    </div>
  );
};
