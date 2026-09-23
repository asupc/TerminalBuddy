import type { StoreApi } from "zustand";
import type { AppState } from "../appStore";
import type { TransferItem } from "../../types";
import { writeClientData } from "../../services/tauri";

const TRANSFER_STORAGE_KEY = "terminalbuddy_transfers";
let _transferSaveTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingTransfersForSave: TransferItem[] | null = null;

function persistTransfers(transfers: TransferItem[], immediately = false) {
	_pendingTransfersForSave = transfers;
	if (immediately) {
		if (_transferSaveTimer) clearTimeout(_transferSaveTimer);
		_transferSaveTimer = null;
		localStorage.setItem(TRANSFER_STORAGE_KEY, JSON.stringify(transfers));
		_pendingTransfersForSave = null;
		return;
	}
	if (_transferSaveTimer) return;
	_transferSaveTimer = setTimeout(() => {
		const pending = _pendingTransfersForSave;
		_transferSaveTimer = null;
		_pendingTransfersForSave = null;
		if (pending) localStorage.setItem(TRANSFER_STORAGE_KEY, JSON.stringify(pending));
	}, 500);
}

export const createTransfersSlice = (
	set: StoreApi<AppState>["setState"],
): Partial<AppState> => ({
	// Extra param presets
	extraParamPresets: [],
	addExtraParamPreset: (name, params, tagColor = null, commandMatch = null, mode = "append") =>
		set((state) => {
			const next = [...state.extraParamPresets, { id: crypto.randomUUID(), name, params, mode, tagColor, commandMatch, enabled: true }];
			writeClientData("extra_param_presets", JSON.stringify(next)).catch(() => {});
			return { extraParamPresets: next };
		}),
	updateExtraParamPreset: (id, patch) =>
		set((state) => {
			const next = state.extraParamPresets.map((p) => (p.id === id ? { ...p, ...patch } : p));
			writeClientData("extra_param_presets", JSON.stringify(next)).catch(() => {});
			return { extraParamPresets: next };
		}),
	removeExtraParamPreset: (id) =>
		set((state) => {
			const next = state.extraParamPresets.filter((p) => p.id !== id);
			writeClientData("extra_param_presets", JSON.stringify(next)).catch(() => {});
			return { extraParamPresets: next };
		}),
	reorderExtraParamPresets: (fromId, toId, position) =>
		set((state) => {
			const list = state.extraParamPresets;
			const fromIndex = list.findIndex((p) => p.id === fromId);
			const toIndex = list.findIndex((p) => p.id === toId);
			if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return {};
			const next = [...list];
			const [moved] = next.splice(fromIndex, 1);
			// splice 后 toIndex 可能漂移：若移除点在目标之前，需要回退 1
			const adjustedTarget = fromIndex < toIndex ? toIndex - 1 : toIndex;
			const insertAt = position === "after" ? adjustedTarget + 1 : adjustedTarget;
			next.splice(insertAt, 0, moved);
			writeClientData("extra_param_presets", JSON.stringify(next)).catch(() => {});
			return { extraParamPresets: next };
		}),

	// Server stats
	serverStats: null,
	setServerStats: (stats) => set({ serverStats: stats }),

	// Transfer state
	transfers: (() => {
		try {
			const saved = localStorage.getItem(TRANSFER_STORAGE_KEY);
			if (!saved) return [];
			const items: TransferItem[] = JSON.parse(saved);
			return items.map((t) => (t.status === "active" ? { ...t, status: "failed" as const, error: "应用重启" } : t));
		} catch {
			return [];
		}
	})(),
	addTransfer: (item) =>
		set((state) => {
			const transfers = [...state.transfers, item];
			persistTransfers(transfers, true);
			return { transfers };
		}),
	updateTransferProgress: (id, transferred, total, percent) =>
		set((state) => {
			const transfers = state.transfers.map((t) => (t.id === id ? { ...t, transferred, total, percent } : t));
			persistTransfers(transfers);
			return { transfers };
		}),
	completeTransfer: (id) =>
		set((state) => {
			const transfers = state.transfers.map((t) => (t.id === id ? { ...t, status: "completed" as const, percent: 100 } : t));
			persistTransfers(transfers, true);
			return { transfers };
		}),
	failTransfer: (id, error) =>
		set((state) => {
			const transfers = state.transfers.map((t) => (t.id === id ? { ...t, status: "failed" as const, error } : t));
			persistTransfers(transfers, true);
			return { transfers };
		}),
	removeTransfer: (id) =>
		set((state) => {
			const transfers = state.transfers.filter((t) => t.id !== id);
			persistTransfers(transfers, true);
			return { transfers };
		}),
	clearCompletedTransfers: (terminalId) =>
		set((state) => {
			const transfers = state.transfers.filter((t) => t.terminalId !== terminalId || t.status !== "completed");
			persistTransfers(transfers, true);
			return { transfers };
		}),
	clearCompletedTransfersByProfile: (profileId) =>
		set((state) => {
			const transfers = state.transfers.filter((t) => t.profileId !== profileId || t.status !== "completed");
			persistTransfers(transfers, true);
			return { transfers };
		}),
});
