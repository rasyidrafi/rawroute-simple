"use client";

import type { PropsWithChildren } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Theme = "light" | "dark" | "system";
type ResolvedTheme = Exclude<Theme, "system">;

type ThemeContextValue = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
};

const THEME_STORAGE_KEY = "rawroute-theme";
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";

  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (storedTheme === "light" || storedTheme === "dark" || storedTheme === "system") {
      return storedTheme;
    }
    if (storedTheme !== null) window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Fall back to the operating system when storage is unavailable.
  }
  return "system";
}

function readSystemTheme(): ResolvedTheme {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: ResolvedTheme) {
  const root = document.documentElement;
  const themeChanged =
    !root.classList.contains(theme) || root.style.colorScheme !== theme;

  if (themeChanged) root.classList.add("theme-change-no-transition");
  root.classList.remove("light", "dark");
  root.classList.add(theme);
  root.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#18181b" : "#f6f5f1");

  if (themeChanged) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        root.classList.remove("theme-change-no-transition");
      });
    });
  }
}

export function ThemeProvider({ children }: PropsWithChildren) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(readSystemTheme);
  const resolvedTheme = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => {
      const nextSystemTheme = event.matches ? "dark" : "light";
      setSystemTheme(nextSystemTheme);
      if (theme === "system") applyTheme(nextSystemTheme);
    };

    setSystemTheme(media.matches ? "dark" : "light");
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [theme]);

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        const nextTheme = readStoredTheme();
        const nextSystemTheme = readSystemTheme();
        setThemeState(nextTheme);
        setSystemTheme(nextSystemTheme);
        applyTheme(nextTheme === "system" ? nextSystemTheme : nextTheme);
      }
    }

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const setTheme = useCallback((nextTheme: Theme) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // The selected theme still applies for this page when storage is unavailable.
    }
    const nextSystemTheme = readSystemTheme();
    setSystemTheme(nextSystemTheme);
    applyTheme(nextTheme === "system" ? nextSystemTheme : nextTheme);
    setThemeState(nextTheme);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within a ThemeProvider");
  return context;
}
