import React, { useState } from 'react';
import { createProfile, updateProfile } from '../api/profiles';
import type { Profile, TerminalType } from '../types';

interface Props {
  profile: Profile | null;
  onClose: () => void;
  onSaved: () => void;
}

const ProfileDialog: React.FC<Props> = ({ profile, onClose, onSaved }) => {
  const [name, setName] = useState(profile?.name || '');
  const [group, setGroup] = useState(profile?.group || '');
  const [terminalType, setTerminalType] = useState(profile?.terminalType || 'powershell');
  const [sshHost, setSshHost] = useState(profile?.sshHost || '');
  const [sshPort, setSshPort] = useState(profile?.sshPort?.toString() || '22');
  const [sshUser, setSshUser] = useState(profile?.sshUser || '');
  const [dockerName, setDockerName] = useState(profile?.dockerContainerName || '');
  const [mstscHost, setMstscHost] = useState(profile?.mstscHost || '');
  const [mstscPort, setMstscPort] = useState(profile?.mstscPort?.toString() || '3389');
  const [mstscUser, setMstscUser] = useState(profile?.mstscUser || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!name.trim()) {
      setError('请输入连接名称');
      return;
    }
    if (terminalType === 'ssh' && !sshHost.trim()) {
      setError('请输入 SSH 主机地址');
      return;
    }
    if (terminalType === 'docker' && !dockerName.trim()) {
      setError('请输入 Docker 容器名称');
      return;
    }
    if (terminalType === 'mstsc' && !mstscHost.trim()) {
      setError('请输入远程桌面主机地址');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const data: Profile = {
        id: profile?.id || crypto.randomUUID(),
        name, group, terminalType: terminalType as any,
        startupPath: '', startupCommands: [],
        environmentVariables: {},
        colorTheme: 'dark-default', tabColor: null, windowSize: null,
        sshHost: terminalType === 'ssh' ? sshHost : undefined,
        sshPort: terminalType === 'ssh' ? parseInt(sshPort) || 22 : undefined,
        sshUser: terminalType === 'ssh' ? sshUser : undefined,
        dockerContainerName: terminalType === 'docker' ? dockerName : undefined,
        mstscHost: terminalType === 'mstsc' ? mstscHost : undefined,
        mstscPort: terminalType === 'mstsc' ? parseInt(mstscPort) || 3389 : undefined,
        mstscUser: terminalType === 'mstsc' ? mstscUser : undefined,
        createdAt: profile?.createdAt || new Date().toISOString(),
        lastUsedAt: profile?.lastUsedAt || null,
      };
      if (profile) {
        await updateProfile(profile.id, data);
      } else {
        await createProfile(data);
      }
      onSaved();
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || '保存连接失败';
      setError(msg);
    } finally { setSaving(false); }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#1e1e3a', border: '1px solid #3a3a5a', borderRadius: 12,
        padding: 24, width: 420, maxWidth: '90vw',
      }}>
        <h3 style={{ fontSize: 16, color: '#a0a0d0', marginBottom: 20 }}>
          {profile ? '编辑连接' : '新建连接'}
        </h3>

        <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：生产服务器" />

        <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>分组</label>
        <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="例如：远程服务器" />

        <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>类型</label>
        <select value={terminalType} onChange={(e) => setTerminalType(e.target.value as TerminalType)} style={{
          width: '100%', padding: '8px 12px', border: '1px solid #3a3a5a', borderRadius: 6,
          background: '#12122a', color: '#e0e0e0', fontSize: 13, outline: 'none', cursor: 'pointer',
        }}>
          <option value="powershell">PowerShell</option>
          <option value="cmd">CMD</option>
          <option value="ssh">SSH</option>
          <option value="docker">Docker</option>
          <option value="k8s">Kubernetes</option>
          <option value="mstsc">远程桌面 (RDP)</option>
        </select>

        {terminalType === 'ssh' && (
          <>
            <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>主机地址</label>
            <input value={sshHost} onChange={(e) => setSshHost(e.target.value)} />
            <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>端口</label>
            <input value={sshPort} onChange={(e) => setSshPort(e.target.value)} />
            <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>用户名</label>
            <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
          </>
        )}

        {terminalType === 'docker' && (
          <>
            <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>容器名称</label>
            <input value={dockerName} onChange={(e) => setDockerName(e.target.value)} placeholder="例如：mysql-container" />
          </>
        )}

        {terminalType === 'mstsc' && (
          <>
            <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>主机地址</label>
            <input value={mstscHost} onChange={(e) => setMstscHost(e.target.value)} placeholder="例如：192.168.1.100" />
            <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>端口</label>
            <input value={mstscPort} onChange={(e) => setMstscPort(e.target.value)} />
            <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 4, marginTop: 12 }}>用户名</label>
            <input value={mstscUser} onChange={(e) => setMstscUser(e.target.value)} placeholder="例如：Administrator" />
          </>
        )}

        {error && <div style={{ color: '#ff6b6b', fontSize: 13, marginTop: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 24 }}>
          <button onClick={onClose} style={{
            padding: '8px 20px', border: '1px solid #3a3a5a', borderRadius: 6,
            background: 'transparent', color: '#8a8aaa',
          }}>取消</button>
          <button onClick={handleSave} disabled={saving || !name} style={{
            padding: '8px 20px', border: 'none', borderRadius: 6,
            background: '#5b5bb5', color: '#fff', opacity: saving || !name ? 0.6 : 1,
          }}>{saving ? '保存中...' : '保存'}</button>
        </div>
      </div>
    </div>
  );
};

export default ProfileDialog;
