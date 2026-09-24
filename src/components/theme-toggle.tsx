"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const selectedTheme =
    theme === "light" || theme === "dark" ? theme : "system";
  const ThemeIcon =
    selectedTheme === "system"
      ? MonitorIcon
      : selectedTheme === "dark"
        ? MoonIcon
        : SunIcon;

  function selectTheme(value: string) {
    if (value === "system" || value === "light" || value === "dark") {
      setTheme(value);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={className}
            aria-label={`Color theme: ${selectedTheme}`}
            title="Color theme"
          >
            <ThemeIcon />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Appearance</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={selectedTheme}
            onValueChange={selectTheme}
          >
            <DropdownMenuRadioItem value="system" closeOnClick>
              <MonitorIcon />
              System
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="light" closeOnClick>
              <SunIcon />
              Light
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark" closeOnClick>
              <MoonIcon />
              Dark
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
