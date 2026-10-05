"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const THEME_LS = "tutor.theme";

function currentIsDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

export default function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Lee el DOM tras montar (el script de layout ya aplicó la clase pre-pintado).
    // eslint-disable-next-line
    setDark(currentIsDark());
    setMounted(true);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(THEME_LS, next ? "dark" : "light");
    } catch {
      // ignorar
    }
  }

  if (!mounted) return null;
  return (
    <Button
      variant="outline"
      onClick={toggle}
      title={dark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
    >
      {dark ? "☀️ Claro" : "🌙 Oscuro"}
    </Button>
  );
}
