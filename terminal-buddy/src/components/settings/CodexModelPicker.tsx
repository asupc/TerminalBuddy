import { useMemo, useState } from 'react';

export function CodexModelPicker({ models, selected, defaultModel, disabled, onChange }: {
  models: string[];
  selected: string[];
  defaultModel: string;
  disabled: boolean;
  onChange: (selected: string[], defaultModel: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState('');
  const available = useMemo(() => [...new Set([...selected, ...models])], [selected, models]);
  const visible = available.filter(id => id.toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id];
    onChange(next, next.includes(defaultModel) ? defaultModel : next[0] ?? '');
  };
  const add = () => {
    const ids = manual.split(/[,，\s]+/).filter(Boolean);
    if (!ids.length) return;
    const next = [...new Set([...selected, ...ids])];
    onChange(next, defaultModel || next[0]);
    setManual('');
  };
  return (
    <div className="codex-model-picker">
      <div className="codex-model-picker-heading"><strong>可用模型</strong><span>已选择 {selected.length} 个</span></div>
      <div className="codex-model-manual">
        <input aria-label="手动添加模型" value={manual} disabled={disabled} maxLength={4096} placeholder="输入模型 ID，多个用逗号分隔" spellCheck={false}
          onChange={event => setManual(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
        <button type="button" className="claude-segment-btn" disabled={disabled || !manual.trim()} onClick={add}>添加模型</button>
      </div>
      {available.length > 0 && <>
        <div className="codex-model-picker-tools">
          <input aria-label="搜索模型" value={query} disabled={disabled} placeholder="搜索模型…" onChange={event => setQuery(event.target.value)} />
          <button type="button" className="claude-segment-btn mini" disabled={disabled || !visible.length} onClick={() => {
            const next = [...new Set([...selected, ...visible])]; onChange(next, defaultModel || next[0]);
          }}>全选</button>
          <button type="button" className="claude-segment-btn mini" disabled={disabled || !selected.length} onClick={() => onChange([], '')}>清空</button>
        </div>
        <div className="codex-model-picker-list">
          {visible.map(id => <div className={`codex-model-picker-row${selected.includes(id) ? ' selected' : ''}`} key={id}>
            <label><input type="checkbox" disabled={disabled} checked={selected.includes(id)} onChange={() => toggle(id)} /><span title={id}>{id}</span></label>
            {selected.includes(id) && <button type="button" className={`claude-segment-btn mini${defaultModel === id ? ' active' : ''}`} disabled={disabled || defaultModel === id} onClick={() => onChange(selected, id)}>{defaultModel === id ? '默认模型' : '设为默认'}</button>}
          </div>)}
          {!visible.length && <p className="codex-provider-description">没有匹配的模型</p>}
        </div>
      </>}
      <p className="codex-provider-description">勾选的模型会出现在快速启动菜单中；默认模型用于启用供应商后的常规启动。</p>
    </div>
  );
}
