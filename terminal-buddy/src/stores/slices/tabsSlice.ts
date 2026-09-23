import type { StoreApi } from "zustand";
import type { AppState } from "../appStore";

export const createTabsSlice = (
	set: StoreApi<AppState>["setState"],
): Partial<AppState> => ({
	// Tab Groups
	groups: [{ id: "default", name: "默认", collapsed: false }],
	addGroup: (name, color) =>
		set((state) => ({
			groups: [...state.groups, { id: crypto.randomUUID(), name, color, collapsed: false }],
		})),
	removeGroup: (id) =>
		set((state) => {
			if (id === "default") return state;
			return {
				groups: state.groups.filter((g) => g.id !== id),
				sessions: state.sessions.map((s) => (s.groupId === id ? { ...s, groupId: "default", groupName: undefined } : s)),
			};
		}),
	renameGroup: (id, name) =>
		set((state) => ({
			groups: state.groups.map((g) => (g.id === id ? { ...g, name } : g)),
			sessions: state.sessions.map((session) => (session.groupId === id ? { ...session, groupName: name } : session)),
		})),
	setGroupColor: (id, color) =>
		set((state) => ({
			groups: state.groups.map((g) => (g.id === id ? { ...g, color } : g)),
		})),
	toggleGroupCollapse: (id) =>
		set((state) => ({
			groups: state.groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)),
		})),
	moveSessionToGroup: (sessionId, groupId) =>
		set((state) => ({
			sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, groupId, groupName: state.groups.find((group) => group.id === groupId)?.name } : s)),
		})),

	// Last click region for F2 routing
	lastClickRegion: null,
	setLastClickRegion: (region) => set({ lastClickRegion: region }),
});
