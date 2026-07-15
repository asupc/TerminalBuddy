import { FC } from 'react';
import { BookOpen, Download, Globe2, MessageSquareWarning } from 'lucide-react';
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
          <p className="about-description">面向 Windows 的桌面终端与远程连接工具。</p>

          <div className="about-tech">
            <h3>技术栈</h3>
            <div className="tech-stack">
              <span className="tech-badge">React 19</span>
              <span className="tech-badge">TypeScript</span>
              <span className="tech-badge">Rust</span>
              <span className="tech-badge">Tauri 2</span>
              <span className="tech-badge">xterm.js 6</span>
              <span className="tech-badge">Monaco Editor</span>
            </div>
          </div>

          <div className="about-links">
            <h3>相关链接</h3>
            <div className="links-grid">
              <a
                href="https://gitee.com/updateme/terminal-buddy"
                target="_blank"
                rel="noopener noreferrer"
                className="about-link"
              >
                <Globe2 aria-hidden="true" />
                <span>项目主页</span>
              </a>
              <a
                href="https://gitee.com/updateme/terminal-buddy/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="about-link"
              >
                <MessageSquareWarning aria-hidden="true" />
                <span>问题反馈</span>
              </a>
              <a
                href="https://gitee.com/updateme/terminal-buddy/blob/master/README.md"
                target="_blank"
                rel="noopener noreferrer"
                className="about-link"
              >
                <BookOpen aria-hidden="true" />
                <span>文档</span>
              </a>
              <a
                href="https://gitee.com/updateme/terminal-buddy/releases"
                target="_blank"
                rel="noopener noreferrer"
                className="about-link"
              >
                <Download aria-hidden="true" />
                <span>下载</span>
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
