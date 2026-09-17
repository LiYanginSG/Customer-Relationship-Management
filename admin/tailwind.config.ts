import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#1a1d21", soft: "#5c6470", faint: "#8b93a1" },
        line: "#e4e7ec",
        surface: { DEFAULT: "#ffffff", sunk: "#f7f8fa" },
        // Urgency colours. Deliberately restrained -- if everything shouts,
        // the genuinely overdue premium stops standing out.
        alert: "#b42318",
        warn: "#b54708",
        good: "#067647",
        calm: "#175cd3",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
