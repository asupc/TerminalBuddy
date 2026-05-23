const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.java', '.cs', '.cpp', '.c', '.h',
  '.py', '.rs', '.go', '.rb', '.php', '.swift', '.kt',
  '.html', '.css', '.scss', '.less', '.vue', '.svelte',
  '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.env', '.gitignore',
  '.md', '.txt', '.log', '.csv',
  '.sh', '.bat', '.ps1',
]);

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.js': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.html': 'html', '.vue': 'html', '.svelte': 'html',
  '.css': 'css', '.scss': 'css', '.less': 'css',
  '.json': 'json',
  '.md': 'markdown',
  '.java': 'java',
  '.cs': 'csharp',
  '.cpp': 'cpp', '.c': 'cpp', '.h': 'cpp',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.xml': 'xml',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.sh': 'shell', '.bat': 'bat', '.ps1': 'powershell',
};

export function isTextFile(filePath: string): boolean {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex === -1) return false;
  const ext = filePath.slice(dotIndex).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

export function getMonacoLanguage(filePath: string): string {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex === -1) return 'plaintext';
  const ext = filePath.slice(dotIndex).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] || 'plaintext';
}

export function getFileName(filePath: string): string {
  const sep = filePath.includes('/') ? '/' : '\\';
  const parts = filePath.split(sep);
  return parts[parts.length - 1];
}
