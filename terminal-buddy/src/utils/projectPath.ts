import type { Profile, Project } from '../types';
import { serverUsesWindowsPaths } from '../services/platform';

export function normalizeProjectPath(path: string): string {
  const clean = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const normalized = serverUsesWindowsPaths() ? clean.toLowerCase() : clean;
  const prefix = normalized.startsWith('//') ? '//' : normalized.startsWith('/') ? '/' : '';
  const segments: string[] = [];
  for (const segment of normalized.slice(prefix.length).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..' && segments.length && segments[segments.length - 1] !== '..' && !segments[segments.length - 1].endsWith(':')) segments.pop();
    else if (segment !== '..' || !prefix) segments.push(segment);
  }
  return prefix + segments.join('/');
}

export function effectiveProfilePath(profile: Profile, projects: Project[]): string {
  const base = projects.find(p => p.name === (profile.group || '默认'))?.path.trim() || '';
  const override = profile.startupPath.trim();
  if (!override) return base;
  if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(override)) return override;
  return base ? `${base.replace(/[\\/]+$/, '')}/${override}` : '';
}

/** Longest configured project ancestor wins; never match sibling path prefixes. */
export function projectForDirectory(projects: Project[], dir: string): Project | undefined {
  const key = normalizeProjectPath(dir);
  return projects.filter(p => {
    const base = normalizeProjectPath(p.path);
    return base && (key === base || key.startsWith(`${base}/`));
  }).sort((a, b) => normalizeProjectPath(b.path).length - normalizeProjectPath(a.path).length)[0];
}
