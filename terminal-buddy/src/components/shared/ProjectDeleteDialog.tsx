import { FC } from 'react';
import { useAppStore } from '../../stores/appStore';
import { saveProjects } from '../../services/tauri';
import { ConfirmDialog } from './Dialog';

interface ProjectDeleteDialogProps {
  /** 要删除的项目名。 */
  projectName: string;
  onClose: () => void;
}

/**
 * 删除项目确认框。
 * 「项目与命令」面板与会话标签栏共用，保证两处删除项目的保存行为一致。
 */
export const ProjectDeleteDialog: FC<ProjectDeleteDialogProps> = ({ projectName, onClose }) => {
  const projects = useAppStore(s => s.projects);
  const setProjects = useAppStore(s => s.setProjects);

  return (
    <ConfirmDialog
      title="删除项目"
      message={`确定删除项目「${projectName}」吗？`}
      onClose={onClose}
      onConfirm={() => void (async () => {
        const updated = projects.filter(p => p.name !== projectName);
        try {
          await saveProjects(updated.filter(p => p.path.trim()));
          setProjects(updated);
          onClose();
        } catch (error) { console.error('删除项目失败:', error); }
      })()}
      confirmText="删除"
    />
  );
};
