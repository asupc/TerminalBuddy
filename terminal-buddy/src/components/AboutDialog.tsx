import { FC } from 'react';
import appIcon from '../assets/app-icon.png';
import { APP_VERSION } from '../version';
import './AboutDialog.css';

interface AboutDialogProps {
  onClose: () => void;
}

export const AboutDialog: FC<AboutDialogProps> = ({ onClose }) => {
  const appVersion = APP_VERSION;

  return (
    <div className="about-dialog-overlay" onClick={onClose}>
      <div className="about-dialog" onClick={e => e.stopPropagation()}>
        <div className="about-header">
          <img src={appIcon} alt="TerminalBuddy" className="about-logo" />
          <div className="about-title-section">
            <h1 className="about-title">TerminalBuddy</h1>
            <p className="about-version">v{appVersion}</p>
          </div>
        </div>

        <div className="about-content">
          <p className="about-description">
            一个基于 Tauri 2 + React 18 + Rust 构建的现代化 Windows 桌面终端模拟器。
          </p>

          <div className="about-features">
            <h3>✨ 核心功能</h3>
            <ul>
              <li>多终端类型支持 - PowerShell, CMD, SSH, Docker, K8s, MSTSC</li>
              <li>智能配置文件管理与层级分组</li>
              <li>灵活的标签页与分屏布局</li>
              <li>SSH 远程文件管理器</li>
              <li>实时服务器监控</li>
              <li>Web 远程访问支持</li>
              <li>智能命令补全与模板库</li>
              <li>自定义主题系统</li>
            </ul>
          </div>

          <div className="about-tech">
            <h3>🛠️ 技术栈</h3>
            <div className="tech-stack">
              <span className="tech-badge">React 18</span>
              <span className="tech-badge">TypeScript</span>
              <span className="tech-badge">Rust</span>
              <span className="tech-badge">Tauri 2</span>
              <span className="tech-badge">xterm.js 6</span>
              <span className="tech-badge">Monaco Editor</span>
            </div>
          </div>

          <div className="about-links">
            <h3>🔗 相关链接</h3>
            <div className="links-grid">
              <a
                href="https://gitee.com/updateme/terminal-buddy"
                target="_blank"
                rel="noopener noreferrer"
                className="about-link"
              >
                📦 项目主页
              </a>
              <a
                href="https://gitee.com/updateme/terminal-buddy/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="about-link"
              >
                🐛 问题反馈
              </a>
              <a
                href="https://gitee.com/updateme/terminal-buddy/blob/master/README.md"
                target="_blank"
                rel="noopener noreferrer"
                className="about-link"
              >
                📄 文档
              </a>
              <a
                href="https://gitee.com/updateme/terminal-buddy/releases"
                target="_blank"
                rel="noopener noreferrer"
                className="about-link"
              >
                📥 下载
              </a>
            </div>
          </div>
        </div>

        <div className="about-footer">
          <p className="about-copyright">
            © 2026 TerminalBuddy • MIT 许可证
          </p>
          <button className="about-close-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
