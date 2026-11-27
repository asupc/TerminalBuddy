import React, { FC } from 'react';
import type { Profile } from '../../types';

export const PROFILE_TYPE_ICONS: Record<string, string> = {
  powershell: 'PS',
  pwsh: 'PS7',
  cmd: 'CMD',
  ssh: 'SSH',
  docker: 'DK',
  k8s: 'K8S',
  mstsc: 'RDP',
};

export interface ProfileTagListProps {
  profiles: Profile[];
  selectedProfileId: string | null;
  isProfileSelected?: (profile: Profile) => boolean;
  renamingProfileId: string | null;
  renamingProfileName: string;
  onRenamingProfileChange: (value: string) => void;
  onRenamingProfileSubmit: () => void;
  onRenamingProfileCancel: () => void;
  onSelectProfile: (profile: Profile) => void;
  onStartTerminal: (profile: Profile) => void;
  onContextMenu: (e: React.MouseEvent, profile: Profile) => void;
  onDragStart?: (e: React.DragEvent, profile: Profile) => void;
  onDragEnd?: () => void;
  className?: string;
}

/**
 * 项目下的配置平铺标签组：自适应侧栏宽度自动换行，一行可展示多个配置。
 * 支持单击选中、双击启动、右键配置菜单、拖拽与行内重命名。
 */
export const ProfileTagList: FC<ProfileTagListProps> = ({
  profiles,
  selectedProfileId,
  isProfileSelected,
  renamingProfileId,
  renamingProfileName,
  onRenamingProfileChange,
  onRenamingProfileSubmit,
  onRenamingProfileCancel,
  onSelectProfile,
  onStartTerminal,
  onContextMenu,
  onDragStart,
  onDragEnd,
  className,
}) => {
  if (profiles.length === 0) return null;

  return (
    <div className={`profile-tag-list${className ? ` ${className}` : ''}`}>
      {profiles.map(profile => {
        const isSelected = isProfileSelected
          ? isProfileSelected(profile)
          : selectedProfileId === profile.id;
        const isRenaming = renamingProfileId === profile.id;
        const typeLabel = PROFILE_TYPE_ICONS[profile.terminalType] || profile.terminalType.toUpperCase();
        const cmdPreview = profile.startupCommands?.filter(Boolean).join(' && ');
        const title = [
          profile.name,
          cmdPreview || '',
          '双击启动 · 右键更多操作',
        ].filter(Boolean).join('\n');

        return (
          <div
            key={profile.id}
            className={`profile-tag-item${isSelected ? ' selected' : ''}${isRenaming ? ' renaming' : ''}`}
            title={isRenaming ? undefined : title}
            draggable={!isRenaming && Boolean(onDragStart)}
            onDragStart={onDragStart && !isRenaming ? (e) => onDragStart(e, profile) : undefined}
            onDragEnd={onDragEnd}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              onSelectProfile(profile);
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSelectProfile(profile);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (isRenaming) return;
              onStartTerminal(profile);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(e, profile);
            }}
          >
            <span className="profile-tag-type">{typeLabel}</span>
            {isRenaming ? (
              <input
                className="profile-tag-rename-input"
                value={renamingProfileName}
                onChange={(e) => onRenamingProfileChange(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') onRenamingProfileSubmit();
                  if (e.key === 'Escape') onRenamingProfileCancel();
                }}
                onBlur={onRenamingProfileSubmit}
                onClick={(e) => e.stopPropagation()}
                autoFocus
              />
            ) : (
              <span
                className="profile-tag-name"
                style={profile.tabColor ? { color: profile.tabColor } : undefined}
              >
                {profile.name}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
};
