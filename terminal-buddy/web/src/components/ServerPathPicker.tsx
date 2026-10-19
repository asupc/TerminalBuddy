import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ServerDirectory } from '../types';
import { Dialog } from './Dialog';
import { normalizePath } from '../utils/projects';

const pathKey = (path: string) => normalizePath(path, /^(?:[a-z]:|\\\\)/i.test(path));
const withinRoot = (path: string, root: string) => {
  const key = pathKey(path);
  const base = pathKey(root);
  return key === base || key.startsWith(base.replace(/\/$/, '') + '/');
};

export function ServerPathPicker({
  initialPath,
  onPick,
  onClose,
}: {
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [roots, setRoots] = useState<ServerDirectory[]>([]);
  const [rootsLoading, setRootsLoading] = useState(true);
  const [root, setRoot] = useState('');
  const [path, setPath] = useState('');
  const [loadedPath, setLoadedPath] = useState('');
  const [nodes, setNodes] = useState<ServerDirectory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setRootsLoading(true);
    setRoots([]);
    setRoot('');
    setPath('');
    setLoadedPath('');
    setNodes([]);
    setError('');
    api.getFsRoots()
      .then((list) => {
        if (!active) return;
        const selected = list
          .filter((entry) => initialPath && withinRoot(initialPath, entry.path))
          .sort((a, b) => b.path.length - a.path.length)[0] || list[0];
        setRoots(list);
        setRoot(selected?.path || '');
        setPath(selected && initialPath && withinRoot(initialPath, selected.path)
          ? initialPath : selected?.path || '');
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setRootsLoading(false);
      });
    return () => { active = false; };
  }, [initialPath]);
  useEffect(() => {
    if (!path) return;
    let active = true;
    setLoading(true);
    setNodes([]);
    setError('');
    api.getFsDirectories(path)
      .then((list) => {
        if (active) {
          setNodes(list);
          setLoadedPath(path);
        }
      })
      .catch((reason) => {
        if (active) {
          setNodes([]);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [path]);
  return (
    <Dialog
      title="选择服务器目录"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={!path || rootsLoading || loading || !!error || loadedPath !== path}
            onClick={() => onPick(path)}
          >
            选择此目录
          </button>
        </>
      }
    >
      <div className="project-form">
        {rootsLoading ? <p>正在加载可浏览目录…</p> : roots.length ? (
          <>
            <label>
              可浏览目录
              <select
                value={root}
                onChange={(e) => {
                  setRoot(e.target.value);
                  setPath(e.target.value);
                }}
              >
                {roots.map((entry) => (
                  <option key={entry.path} value={entry.path}>
                    {entry.name} · {entry.path}
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
                    setPath(withinRoot(parent, root) ? parent : root);
                  }}
                >
                  ↑ 上一级
                </button>
              )}
              {loading || (loadedPath !== path && !error) ? <p>加载中…</p> : nodes.map((node) => (
                <button
                  key={node.path}
                  className="server-directory-row"
                  onClick={() => setPath(node.path)}
                >
                  📁 {node.name}
                </button>
              ))}
              {!loading && loadedPath === path && !nodes.length && !error && <p>当前目录没有子目录</p>}
            </div>
          </>
        ) : !error && <p>暂无可浏览目录，请挂载项目目录或在项目路径中输入服务器绝对路径。</p>}
        {error && <div className="nav-error" role="alert">{error}</div>}
      </div>
    </Dialog>
  );
}
