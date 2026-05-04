import { create } from "zustand";

interface UiState {
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  paletteOpen: false,
  setPaletteOpen: (v) => set({ paletteOpen: v }),
}));
