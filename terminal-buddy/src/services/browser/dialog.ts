import { invoke } from './core';
import { request, uploadFiles } from './connection';
interface Options { directory?: boolean; multiple?: boolean; defaultPath?: string; title?: string; filters?: unknown[] }
interface Node { name: string; path: string; is_directory: boolean }

async function choose(options: Options, saving: boolean): Promise<string | string[] | null> {
  const projects = await request<Array<{ name: string; path: string }>>('/api/projects');
  const roots = projects.filter(project => project.path);
  if (!roots.length) throw new Error('请先在项目管理中登记服务器目录');
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:20000;background:#0008;display:grid;place-items:center;color:var(--text-primary,#ddd)';
    const panel = document.createElement('div');
    panel.style.cssText = 'width:580px;max-width:90vw;background:var(--bg-primary,#20252e);padding:20px;border:1px solid #555;border-radius:10px';
    const title = document.createElement('h3'); title.textContent = options.title ?? (saving ? '保存到服务器' : options.directory ? '选择服务器目录' : '选择文件');
    const rootSelect = document.createElement('select'); rootSelect.style.cssText = 'width:100%;padding:8px;margin-bottom:10px';
    roots.forEach(root => { const option = document.createElement('option'); option.value = root.path; option.textContent = `${root.name} · ${root.path}`; rootSelect.append(option); });
    const pathLabel = document.createElement('div'); pathLabel.style.cssText = 'overflow-wrap:anywhere;margin:8px 0';
    const list = document.createElement('div'); list.style.cssText = 'height:280px;overflow:auto;border:1px solid #555;padding:6px';
    const error = document.createElement('div'); error.style.cssText = 'color:#ffb8b8;margin:8px 0'; error.setAttribute('role', 'alert');
    const fileName = document.createElement('input'); fileName.placeholder = '文件名'; fileName.value = options.defaultPath?.split(/[\\/]/).pop() ?? '';
    fileName.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;margin:10px 0';
    const controls = document.createElement('div'); controls.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:14px';
    let currentPath = roots[0].path;
    const selected = new Set<string>();
    const close = (value: string | string[] | null) => { overlay.remove(); document.removeEventListener('keydown', escape); resolve(value); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(null); };
    const button = (label: string, action: () => void) => { const element = document.createElement('button'); element.textContent = label; element.onclick = action; return element; };
    let generation = 0;
    const load = async (path: string) => {
      const revision = ++generation;
      selected.clear(); error.textContent = '';
      try {
        const nodes = await invoke<Node[]>('list_directory', { path, exclusions: null });
        if (revision !== generation) return;
        currentPath = path; pathLabel.textContent = path; list.replaceChildren();
        const parent = path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');
        if (parent && parent !== path && path !== rootSelect.value) list.append(button('↑ 上一级', () => { void load(parent); }));
        nodes.filter(node => !options.directory || node.is_directory).forEach(node => {
          const row = button(`${node.is_directory ? '📁' : '📄'} ${node.name}`, () => {
            if (node.is_directory) { void load(node.path); return; }
            if (options.multiple) {
              if (selected.has(node.path)) { selected.delete(node.path); row.style.background = ''; }
              else { selected.add(node.path); row.style.background = '#467bc2'; }
            } else close(node.path);
          });
          row.style.cssText = 'display:block;width:100%;text-align:left;padding:8px;border:0;background:transparent;color:inherit;cursor:pointer'; list.append(row);
        });
      } catch (reason) { if (revision === generation) error.textContent = reason instanceof Error ? reason.message : '目录加载失败'; }
    };
    rootSelect.onchange = () => { void load(rootSelect.value); };
    if (!saving && !options.directory) controls.append(button('上传本机文件', () => {
      const input = document.createElement('input'); input.type = 'file'; input.multiple = Boolean(options.multiple);
      input.onchange = async () => {
        try { const paths = await uploadFiles(Array.from(input.files ?? [])); if (paths.length) close(options.multiple ? paths : paths[0]); }
        catch (reason) { error.textContent = reason instanceof Error ? reason.message : '上传失败'; }
      }; input.click();
    }));
    controls.append(button('取消', () => close(null)), button(saving ? '保存' : '选择', () => {
      if (saving) {
        if (!fileName.value.trim() || /[\\/]/.test(fileName.value) || ['.', '..'].includes(fileName.value)) { error.textContent = '请输入有效的文件名'; return; }
        close(`${currentPath.replace(/[\\/]+$/, '')}/${fileName.value}`);
      } else if (options.directory) close(options.multiple ? [currentPath] : currentPath);
      else if (selected.size) close(Array.from(selected));
    }));
    panel.append(title, rootSelect, pathLabel, list); if (saving) panel.append(fileName); panel.append(error, controls);
    overlay.append(panel); document.body.append(overlay); document.addEventListener('keydown', escape); void load(currentPath);
  });
}
export function open(options: Options = {}): Promise<string | string[] | null> { return choose(options, false); }
export async function save(options: Options = {}): Promise<string | null> { const result = await choose(options, true); return Array.isArray(result) ? result[0] : result; }
