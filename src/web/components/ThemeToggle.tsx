import { useState } from 'react';

/**
 * 2-way light/dark toggle. index.html's pre-paint script owns the initial
 * class (stored choice, else OS preference); this button flips the class and
 * stores an explicit choice. Clearing site data re-follows the OS.
 */
export function ThemeToggle() {
    const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
    const toggle = () => {
        const next = !dark;
        document.documentElement.classList.toggle('dark', next);
        localStorage.setItem('morelli-theme', next ? 'dark' : 'light');
        setDark(next);
    };
    return (
        <button
            onClick={toggle}
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-200 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
            {dark ? '☀️' : '🌙'}
        </button>
    );
}
