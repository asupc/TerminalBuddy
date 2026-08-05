import type { StoreApi } from "zustand";
import type { AppState } from "../appStore";
import { writeClientData } from "../../services/tauri";

function persistFileTreeNav(state: { navBackStack: string[]; navForwardStack: string[]; fileSortBy: "name" | "size" | "modified"; fileSortDir: "asc" | "desc"; fileRoots: string[] }) {
	writeClientData(
		"file_nav",
		JSON.stringify({
			backStack: state.navBackStack,
			forwardStack: state.navForwardStack,
			sortBy: state.fileSortBy,
			sortDir: state.fileSortDir,
			roots: state.fileRoots,
		}),
	).catch(() => {});
}

export const createFileTreeSlice = (
	set: StoreApi<AppState>["setState"],
	get: StoreApi<AppState>["getState"],
): Partial<AppState> => ({
	// File tree navigation history (back/forward across directories)
	currentDirectory: "",
	setCurrentDirectory: (path) => set({ currentDirectory: path }),
	navBackStack: [],
	navForwardStack: [],
	navigateWithHistory: (path) =>
		set((state) => {
			const current = state.currentDirectory;
			if (!current || current === path) return state;
			const back = [...state.navBackStack, current].slice(-50);
			persistFileTreeNav({ ...state, navBackStack: back, navForwardStack: [] });
			return { currentDirectory: path, navBackStack: back, navForwardStack: [] };
		}),
	navBack: () => {
		const state = get();
		if (state.navBackStack.length === 0) return null;
		const target = state.navBackStack[state.navBackStack.length - 1];
		const back = state.navBackStack.slice(0, -1);
		const forward = state.currentDirectory ? [...state.navForwardStack, state.currentDirectory].slice(-50) : state.navForwardStack;
		persistFileTreeNav({ ...state, navBackStack: back, navForwardStack: forward });
		set({ currentDirectory: target, navBackStack: back, navForwardStack: forward });
		return target;
	},
	navForward: () => {
		const state = get();
		if (state.navForwardStack.length === 0) return null;
		const target = state.navForwardStack[state.navForwardStack.length - 1];
		const forward = state.navForwardStack.slice(0, -1);
		const back = state.currentDirectory ? [...state.navBackStack, state.currentDirectory].slice(-50) : state.navBackStack;
		persistFileTreeNav({ ...state, navBackStack: back, navForwardStack: forward });
		set({ currentDirectory: target, navBackStack: back, navForwardStack: forward });
		return target;
	},

	// File tree sort preference
	fileSortBy: "name",
	fileSortDir: "asc",
	setFileSort: (by, dir) =>
		set((state) => {
			persistFileTreeNav({ ...state, fileSortBy: by, fileSortDir: dir });
			return { fileSortBy: by, fileSortDir: dir };
		}),
	fileRoots: [],
	addFileRoot: (path) =>
		set((state) => {
			const pathKey = path.toLowerCase();
			if (state.fileRoots.some((candidate) => candidate.toLowerCase() === pathKey)) return state;
			const fileRoots = [...state.fileRoots, path];
			persistFileTreeNav({ ...state, fileRoots });
			return { fileRoots };
		}),
	removeFileRoot: (path) =>
		set((state) => {
			const pathKey = path.toLowerCase();
			const fileRoots = state.fileRoots.filter((candidate) => candidate.toLowerCase() !== pathKey);
			persistFileTreeNav({ ...state, fileRoots });
			return { fileRoots };
		}),

	// Internal drag paths (from FileTree to terminal)
	dragPaths: null,
	setDragPaths: (paths) => set({ dragPaths: paths }),

	// Remote file cache (per session)
	remoteFileCache: {},
	setRemoteFileCache: (terminalId, cache) =>
		set((state) => ({
			remoteFileCache: { ...state.remoteFileCache, [terminalId]: cache },
		})),
	clearRemoteFileCache: (terminalId) =>
		set((state) => {
			const { [terminalId]: _, ...rest } = state.remoteFileCache;
			return { remoteFileCache: rest };
		}),

	// Remote clipboard
	remoteClipboard: null,
	setRemoteClipboard: (clipboard) => set({ remoteClipboard: clipboard }),
});
