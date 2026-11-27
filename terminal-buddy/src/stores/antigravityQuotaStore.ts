import { create } from 'zustand';
import { getAntigravityAccountQuota, type AntigravityQuotaSummary } from '../services/tauri';
import { useAppStore } from './appStore';

const STORAGE_KEY = 'tb_agy_quota_cache_v1';
/** 前端共享缓存有效期（3 分钟）；手动点击「刷新」会绕过缓存强制查询。 */
export const ANTIGRAVITY_QUOTA_TTL_MS = 3 * 60 * 1000;

export interface AntigravityQuotaEntry {
  data?: AntigravityQuotaSummary;
  loading: boolean;
  error?: string;
  updatedAt?: number;
}

interface AntigravityQuotaStoreState {
  entries: Record<string, AntigravityQuotaEntry>;
  fetchQuota: (accountId: string | null, forceRefresh?: boolean) => Promise<AntigravityQuotaSummary | undefined>;
}

export function antigravityQuotaCacheKey(accountId: string | null | undefined): string {
  const trimmed = accountId?.trim() ?? '';
  if (!trimmed || trimmed === 'default:antigravity') return '__default__';
  return trimmed.startsWith('antigravity:') ? trimmed.slice('antigravity:'.length) : trimmed;
}

function loadPersistedEntries(): Record<string, AntigravityQuotaEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, { data?: AntigravityQuotaSummary; updatedAt?: number }>;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, AntigravityQuotaEntry> = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (item && item.data) {
        out[key] = {
          data: item.data,
          loading: false,
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : item.data.fetchedAt,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persistEntries(entries: Record<string, AntigravityQuotaEntry>): void {
  try {
    const slim: Record<string, { data: AntigravityQuotaSummary; updatedAt?: number }> = {};
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.data) {
        slim[key] = { data: entry.data, updatedAt: entry.updatedAt };
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch {
    // 忽略隐私模式或配额不足导致的 localStorage 写入失败
  }
}

const inFlight = new Map<string, Promise<AntigravityQuotaSummary | undefined>>();

export const useAntigravityQuotaStore = create<AntigravityQuotaStoreState>((set, get) => ({
  entries: loadPersistedEntries(),
  fetchQuota: async (accountId, forceRefresh = false) => {
    const key = antigravityQuotaCacheKey(accountId);
    const existing = get().entries[key];
    if (
      !forceRefresh
      && existing?.data
      && existing.updatedAt != null
      && Date.now() - existing.updatedAt < ANTIGRAVITY_QUOTA_TTL_MS
    ) {
      return existing.data;
    }

    const running = inFlight.get(key);
    if (running && !forceRefresh) {
      return running;
    }

    set(state => ({
      entries: {
        ...state.entries,
        [key]: { ...state.entries[key], loading: true, error: undefined },
      },
    }));

    const task = getAntigravityAccountQuota(accountId ?? null, forceRefresh)
      .then(data => {
        const now = Date.now();
        set(state => {
          const nextEntries = {
            ...state.entries,
            [key]: { data, loading: false, error: undefined, updatedAt: now },
          };
          persistEntries(nextEntries);
          return { entries: nextEntries };
        });
        // 若接口识别出了会员类型，同步刷新全局账号列表中的 planTier，无需重新拉账号列表
        if (key !== '__default__' && data.planTier) {
          const appState = useAppStore.getState();
          const acctState = appState.antigravityAccountState;
          if (acctState && acctState.accounts.some(a => a.id === key && a.planTier !== data.planTier)) {
            appState.setAntigravityAccountState({
              ...acctState,
              accounts: acctState.accounts.map(a => (a.id === key ? { ...a, planTier: data.planTier } : a)),
            });
          }
        }
        return data;
      })
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        set(state => ({
          entries: {
            ...state.entries,
            [key]: { ...state.entries[key], loading: false, error: message },
          },
        }));
        return undefined;
      })
      .finally(() => {
        if (inFlight.get(key) === task) {
          inFlight.delete(key);
        }
      });

    inFlight.set(key, task);
    return task;
  },
}));
