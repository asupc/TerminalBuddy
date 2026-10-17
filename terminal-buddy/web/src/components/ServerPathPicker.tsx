import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { FileNode, Project } from '../types';
import { Dialog } from './Dialog';
import { normalizePath } from '../utils/projects';

const pathKey = (path: string) => normalizePath(path, /^(?:[a-z]:|\\\\)/i.test(path));

export function ServerPathPicker({
  projects,
  initialPath,
  onPick,
  onClose,
}: {
  projects: Project[];
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const roots = useMemo(() => projects.filter((p) => p.path), [projects]);
  const [root, setRoot] = useState(
    () =>
      roots
        .filter(
          (p) =>
            initialPath &&
            (pathKey(initialPath) === pathKey(p.path) ||
              pathKey(initialPath).startsWith(pathKey(p.path).replace(/\/$/, '') + '/')),
        )
        .sort((a, b) => b.path.length - a.path.length)[0]?.path ||
      roots[0]?.path ||
      '',
  );
  const [path, setPath] = useState(root);
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!path) return;
    let active = true;
    setLoading(true);
    setError('');
    api
      .getFsList(path)
      .then((list) => {
        if (active) setNodes(list.filter((n) => n.is_directory));
      })
      .catch((reason) => {
        if (active) {
          setNodes([]);
          setError(String(reason));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path]);
  return (
    <Dialog
      title="选择服务器目录"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!path || loading || !!error}
            onClick={() => onPick(path)}
          >
            选择此目录
          </button>
        </>
      }
    >
      <div className="project-form">
        {roots.length ? (
          <>
            <label>
              项目根目录
              <select
                value={root}
                onChange={(e) => {
                  setRoot(e.target.value);
                  setPath(e.target.value);
                }}
              >
                {roots.map((p) => (
                  <option key={p.name} value={p.path}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="project-path-label">{path}</div>
            <div className="server-directory-list">
              {pathKey(path) !== pathKey(root) && (
                <button
                  className="btn"
                  onClick={() => {
                    const parent = path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');
                    const key = pathKey(parent);
                    setPath(key.startsWith(pathKey(root).replace(/\/$/, '') + '/') ? parent : root);
                  }}
                >
                  ↑ 上一级
                </button>
              )}
              {loading ? (
                <p>加载中…</p>
              ) : (
                nodes.map((n) => (
                  <button
                    key={n.path}
                    className="server-directory-row"
                    onClick={() => setPath(n.path)}
                  >
                    📁 {n.name}
                  </button>
                ))
              )}
              {!loading && !nodes.length && !error && <p>当前目录没有子目录</p>}
            </div>
          </>
        ) : (
          <p>暂无可浏览的项目目录，请在项目路径中输入服务器绝对路径。</p>
        )}
        {error && (
          <div className="nav-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
