/**
 * 全局状态 — Zustand
 * 目前只管登录态;后续画布状态另立 store
 */
import { create } from "zustand";
import { api, ApiError } from "./api";

interface AuthState {
  /** null = 未初始化(正在 /me 探测中),true = 已登录,false = 未登录 */
  authed: boolean | null;
  /** 应用启动时调一次,根据 cookie 自动判定登录状态 */
  init: () => Promise<void>;
  /** 登录:成功后 authed=true */
  login: (passcode: string) => Promise<void>;
  /** 登出:清后端 cookie + authed=false */
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  authed: null,

  init: async () => {
    try {
      await api.me();
      set({ authed: true });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        set({ authed: false });
      } else {
        // 其它错(网络等)不改 authed,保持未初始化
        console.error("auth init failed:", e);
        set({ authed: false });
      }
    }
  },

  login: async (passcode: string) => {
    await api.login(passcode);
    set({ authed: true });
  },

  logout: async () => {
    try {
      await api.logout();
    } finally {
      set({ authed: false });
    }
  },
}));
