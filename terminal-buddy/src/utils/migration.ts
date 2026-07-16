import { writeClientData } from '../services/tauri';

const MIGRATION_SENTINEL = 'terminalbuddy_migrated_v2';

const MIGRATION_KEYS: Record<string, string> = {
  'saved_tabs': 'terminalbuddy_saved_tabs',
  'extra_param_presets': 'terminalbuddy_extra_param_presets',
  'settings': 'terminalbuddy_settings',
  'theme': 'terminalbuddy_theme',
  'cmd_overrides': 'terminalbuddy_cmd_overrides',
  'cmd_custom': 'terminalbuddy_cmd_custom',
};

export async function migrateLocalStorageToBackend(): Promise<void> {
  if (localStorage.getItem(MIGRATION_SENTINEL)) return;

  for (const [backendKey, lsKey] of Object.entries(MIGRATION_KEYS)) {
    if (backendKey === 'saved_tabs') continue; // handled separately below
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw !== null) {
        await writeClientData(backendKey, raw);
      }
    } catch (e) {
      console.error(`Migration failed for ${lsKey}:`, e);
    }
  }

  // Handle saved_tabs: convert old array format to {tabs, activeIndex}
  try {
    const tabsRaw = localStorage.getItem('terminalbuddy_saved_tabs');
    const activeTab = localStorage.getItem('terminalbuddy_active_tab');
    if (tabsRaw !== null) {
      const tabs = JSON.parse(tabsRaw);
      const activeIndex = activeTab ? parseInt(activeTab, 10) : 0;
      await writeClientData('saved_tabs', JSON.stringify({ tabs, activeIndex }));
    }
  } catch (e) {
    console.error('Migration failed for saved_tabs:', e);
  }

  localStorage.setItem(MIGRATION_SENTINEL, '1');
}
