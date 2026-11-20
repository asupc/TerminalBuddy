import { FC, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { getAllProfiles, saveProjects, updateProfile } from '../../services/tauri';
import { Dialog } from './Dialog';
import type { EnabledAgents, Project } from '../../types';
import { projectEnabledAgents } from '../../types';
import { normalizeProjectPath } from '../../utils/projectPath';
import { open as openDirectory } from '@tauri-apps/plugin-dialog';

interface ProjectEditDialogProps {
  /** 目标项目名：命中已登记项目时进入编辑，否则按该名称新建（可为空）。 */
  targetName?: string;
  onClose: () => void;
}

/**
 * 项目新建 / 编辑对话框。
 * 「项目与命令」面板的项目右键与会话标签栏的分组右键共用，
 * 保证两处对同一个项目的编辑入口和保存规则完全一致。
 */
export const ProjectEditDialog: FC<ProjectEditDialogProps> = ({ targetName, onClose }) => {
  const projects = useAppStore(s => s.projects);
  const setProjects = useAppStore(s => s.setProjects);
  const profiles = useAppStore(s => s.profiles);
  const setProfiles = useAppStore(s => s.setProfiles);

  const editingProject: Project | null = targetName
    ? projects.find(p => p.name === targetName) ?? null
    : null;

  const [projectName, setProjectName] = useState(editingProject?.name || targetName || '');
  const [projectPath, setProjectPath] = useState(editingProject?.path || '');
  const [projectAgents, setProjectAgents] = useState<Required<EnabledAgents>>(projectEnabledAgents(editingProject));
  const [projectError, setProjectError] = useState('');

  const saveProject = async () => {
    const name = projectName.trim();
    const path = projectPath.trim();
    if (!name || !/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path)) {
      setProjectError('请输入项目名称和绝对路径'); return;
    }
    if (projects.some(p => p.name.toLowerCase() === name.toLowerCase() && p.name !== editingProject?.name)) {
      setProjectError('项目名称已存在'); return;
    }
    const updated = [...projects.filter(p => p.name !== editingProject?.name), { name, path, enabledAgents: { ...projectAgents } }];
    // Legacy projects with no inferred path remain visible until edited; only persist valid paths.
    try {
      await saveProjects(updated.filter(p => p.path.trim()));
      if (editingProject) {
        let changed = false;
        for (const profile of profiles.filter(p => (p.group || '默认') === editingProject.name)) {
          // Legacy profiles had their group's path copied into startupPath. Convert
          // only exact matches to inheritance; other directories remain overrides.
          const inherits = editingProject.path &&
            normalizeProjectPath(profile.startupPath) === normalizeProjectPath(editingProject.path);
          if (profile.group !== name || inherits) {
            await updateProfile({ ...profile, group: name, startupPath: inherits ? '' : profile.startupPath });
            changed = true;
          }
        }
        if (changed) setProfiles(await getAllProfiles());
      }
      setProjects(updated);
      onClose();
    } catch (error) { setProjectError(String(error)); }
  };

  return (
    <Dialog
      title={editingProject ? '编辑项目' : '新建项目'}
      className="project-edit-dialog"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>取消</button>
          <button type="submit" form="project-edit-form" className="btn-primary">保存</button>
        </>
      )}
    >
      <form id="project-edit-form" onSubmit={event => { event.preventDefault(); void saveProject(); }}>
        <div className="form-group">
          <label htmlFor="project-edit-name">项目名称 *</label>
          <input id="project-edit-name" value={projectName} onChange={event => { setProjectName(event.target.value); setProjectError(''); }} placeholder="项目名称" autoFocus />
        </div>
        <div className="form-group">
          <label htmlFor="project-edit-path">项目路径 *</label>
          <div className="input-with-button">
            <input id="project-edit-path" value={projectPath} onChange={event => { setProjectPath(event.target.value); setProjectError(''); }} placeholder={'C:\\Projects\\MyProject'} />
            <button type="button" className="browse-btn" onClick={() => void openDirectory({ directory: true, multiple: false, defaultPath: projectPath || undefined }).then(path => {
              if (typeof path === 'string') { setProjectPath(path); setProjectError(''); }
            }).catch(error => setProjectError('浏览目录失败：' + String(error)))}>浏览</button>
          </div>
        </div>
        <div className="form-group">
          <label>启用的 Agent</label>
          <div className="project-edit-agents">
            <label className="project-edit-agent-toggle">
              <input type="checkbox" checked={projectAgents.claude} onChange={event => setProjectAgents(value => ({ ...value, claude: event.target.checked }))} />
              Claude Code
            </label>
            <label className="project-edit-agent-toggle">
              <input type="checkbox" checked={projectAgents.codex} onChange={event => setProjectAgents(value => ({ ...value, codex: event.target.checked }))} />
              Codex
            </label>
            <label className="project-edit-agent-toggle">
              <input type="checkbox" checked={projectAgents.antigravity} onChange={event => setProjectAgents(value => ({ ...value, antigravity: event.target.checked }))} />
              Antigravity CLI
            </label>
          </div>
          <small>右键项目时可按启用的 Agent 展开启动入口；基础命令在设置 → Agent 管理中配置。</small>
        </div>
        {projectError && <div className="error" role="alert">{projectError}</div>}
      </form>
    </Dialog>
  );
};
