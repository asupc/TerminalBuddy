import { invoke } from './core';
import { request, serverPlatform, uploadFiles } from './connection';
interface Options { directory?: boolean; multiple?: boolean; defaultPath?: string; title?: string; filters?: unknown[] }
interface Directory { name: string; path: string }
interface Node extends Directory { is_directory: boolean }

function pathKey(path: string): string {
  const key = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return serverPlatform === 'windows' ? key.toLowerCase() : key;
}
function withinRoot(path: string, root: string): boolean {
  const key = pathKey(path);
  const base = pathKey(root);
  return key === base || key.startsWith(base.endsWith('/') ? base : base + '/');
}
/** 上一级目录；到达文件系统根（POSIX `/`、Windows 盘根、UNC 共享根）时返回 null。 */
function parentOf(path: string): string | null {
  const key = pathKey(path);
  if (key === '/' || /^[a-z]:\/$/.test(key) || /^\/\/[^/]+\/[^/]+$/.test(key)) return null;
  const parent = key.replace(/\/[^/]+$/, '');
  if (!parent) return '/';
  return /^[a-z]:$/.test(parent) ? `${parent}/` : parent;
}

async function choose(options: Options, saving: boolean): Promise<string | string[] | null> {
  const browsingDirectories = Boolean(options.directory && !saving);
  const roots = (await request<Directory[]>(browsingDirectories ? '/api/fs/roots' : '/api/projects'))
    .filter(root => root.path);
  if (!roots.length) throw new Error(browsingDirectories
    ? '暂无可浏览目录，请挂载项目目录或配置 TERMINAL_BUDDY_BROWSE_ROOTS'
    : '请先在项目管理中登记服务器目录');
  const defaultDirectory = options.defaultPath && (options.directory && !saving
    ? options.defaultPath
    : options.defaultPath.replace(/[\\/][^\\/]*$/, ''));
  const initialRoot = roots.filter(root => defaultDirectory && withinRoot(defaultDirectory, root.path))
    .sort((a, b) => b.path.length - a.path.length)[0] ?? roots[0];
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:20000;background:#0008;display:grid;place-items:center;color:var(--text-primary,#ddd)';
    const panel = document.createElement('div');
    panel.style.cssText = 'width:580px;max-width:90vw;background:var(--bg-primary,#20252e);padding:20px;border:1px solid #555;border-radius:10px';
    const title = document.createElement('h3'); title.textContent = options.title ?? (saving ? '保存到服务器' : options.directory ? '选择服务器目录' : '选择文件');
    const rootLabel = document.createElement('label'); rootLabel.textContent = browsingDirectories ? '可浏览目录' : '项目目录';
    const rootSelect = document.createElement('select'); rootSelect.style.cssText = 'width:100%;padding:8px;margin:6px 0 10px';
    roots.forEach(root => { const option = document.createElement('option'); option.value = root.path; option.textContent = `${root.name} · ${root.path}`; rootSelect.append(option); });
    rootSelect.value = initialRoot.path;
    rootLabel.append(rootSelect);
    const pathLabel = document.createElement('div'); pathLabel.style.cssText = 'overflow-wrap:anywhere;margin:8px 0';
    const list = document.createElement('div'); list.style.cssText = 'height:280px;overflow:auto;border:1px solid #555;padding:6px';
    const error = document.createElement('div'); error.style.cssText = 'color:#ffb8b8;margin:8px 0'; error.setAttribute('role', 'alert');
    const fileName = document.createElement('input'); fileName.placeholder = '文件名'; fileName.value = options.defaultPath?.split(/[\\/]/).pop() ?? '';
    fileName.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;margin:10px 0';
    const controls = document.createElement('div'); controls.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:14px';
    let currentPath = defaultDirectory && withinRoot(defaultDirectory, initialRoot.path) ? defaultDirectory : initialRoot.path;
    let generation = 0;
    let closed = false;
    const selected = new Set<string>();
    const close = (value: string | string[] | null) => {
      if (closed) return;
      closed = true; generation++; overlay.remove(); document.removeEventListener('keydown', escape); resolve(value);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(null); };
    const button = (label: string, action: () => void) => { const element = document.createElement('button'); element.type = 'button'; element.textContent = label; element.onclick = action; return element; };
    const confirm = button(saving ? '保存' : '选择', () => {
      if (saving) {
        if (!fileName.value.trim() || /[\\/]/.test(fileName.value) || ['.', '..'].includes(fileName.value)) { error.textContent = '请输入有效的文件名'; return; }
        close(`${currentPath.replace(/[\\/]+$/, '')}/${fileName.value}`);
      } else if (options.directory) close(options.multiple ? [currentPath] : currentPath);
      else if (selected.size) close(Array.from(selected));
    });
    const showParent = (path: string) => {
      // 浏览不限制在入口目录内：可以逐级向上直到文件系统根。
      const parent = parentOf(path);
      if (parent === null) return;
      list.append(button('↑ 上一级', () => { void load(parent); }));
    };
    const load = async (path: string) => {
      const revision = ++generation;
      selected.clear(); error.textContent = ''; confirm.disabled = true;
      pathLabel.textContent = path; list.replaceChildren(); showParent(path);
      const loading = document.createElement('p'); loading.textContent = '加载中…'; list.append(loading);
      try {
        const nodes: Node[] = browsingDirectories
          ? (await request<Directory[]>(`/api/fs/directories?path=${encodeURIComponent(path)}`)).map(node => ({ ...node, is_directory: true }))
          : await invoke<Node[]>('list_directory', { path, exclusions: null });
        if (revision !== generation) return;
        currentPath = path; list.replaceChildren(); showParent(path);
        const visible = nodes.filter(node => !options.directory || node.is_directory);
        visible.forEach(node => {
          const row = button(`${node.is_directory ? '📁' : '📄'} ${node.name}`, () => {
            if (node.is_directory) { void load(node.path); return; }
            if (options.multiple) {
              if (selected.has(node.path)) { selected.delete(node.path); row.style.background = ''; }
              else { selected.add(node.path); row.style.background = '#467bc2'; }
            } else close(node.path);
          });
          row.style.cssText = 'display:block;width:100%;text-align:left;padding:8px;border:0;background:transparent;color:inherit;cursor:pointer'; list.append(row);
        });
        if (!visible.length) { const empty = document.createElement('p'); empty.textContent = options.directory ? '当前目录没有子目录' : '当前目录为空'; list.append(empty); }
        confirm.disabled = false;
      } catch (reason) {
        if (revision === generation) { loading.remove(); error.textContent = reason instanceof Error ? reason.message : '目录加载失败'; }
      }
    };
    rootSelect.onchange = () => { void load(rootSelect.value); };
    if (!saving && !options.directory) controls.append(button('上传本机文件', () => {
      const input = document.createElement('input'); input.type = 'file'; input.multiple = Boolean(options.multiple);
      input.onchange = async () => {
        try { const paths = await uploadFiles(Array.from(input.files ?? [])); if (paths.length) close(options.multiple ? paths : paths[0]); }
        catch (reason) { error.textContent = reason instanceof Error ? reason.message : '上传失败'; }
      }; input.click();
    }));
    controls.append(button('取消', () => close(null)), confirm);
    panel.append(title, rootLabel, pathLabel, list); if (saving) panel.append(fileName); panel.append(error, controls);
    overlay.append(panel); document.body.append(overlay); document.addEventListener('keydown', escape); void load(currentPath);
  });
}
export function open(options: Options = {}): Promise<string | string[] | null> { return choose(options, false); }
export async function save(options: Options = {}): Promise<string | null> { const result = await choose(options, true); return Array.isArray(result) ? result[0] : result; }
