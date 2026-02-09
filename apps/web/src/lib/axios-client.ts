/**
 * Axios client with authentication interceptors
 */

import axios, {
  AxiosError,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api";
const TOKEN_KEY = "amber_auth_token";

// ─── Token Helpers ────────────────────────────────────────────────────────────

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(TOKEN_KEY, token);
}

export function removeToken(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
}

// ─── Axios Instance ───────────────────────────────────────────────────────────

export const apiClient = axios.create({
  baseURL: API_BASE,
  timeout: 120000, // 2 minutes for long-running operations
  headers: {
    "Content-Type": "application/json",
  },
});

// ─── Request Interceptor: Attach Auth Token ──────────────────────────────────

apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  },
);

// ─── Response Interceptor: Auto-Logout on 401/403 ────────────────────────────

apiClient.interceptors.response.use(
  (response: AxiosResponse) => {
    return response;
  },
  (error: AxiosError) => {
    // Auto-logout on authentication errors
    if (error.response?.status === 401 || error.response?.status === 403) {
      removeToken();
      if (
        typeof window !== "undefined" &&
        window.location.pathname !== "/login"
      ) {
        window.location.href = "/login";
      }
    }

    // Extract error message from response body
    const message =
      (error.response?.data as { error?: string })?.error ||
      error.message ||
      "API request failed";

    return Promise.reject(new Error(message));
  },
);
