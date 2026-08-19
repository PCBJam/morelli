import { useSearchParams } from 'react-router-dom';

const ERRORS: Record<string, string> = {
    forbidden: 'Your GitHub account has no allowlisted verified email. Ask an admin to add you to ALLOWED_EMAILS.',
    oauth: 'GitHub sign-in failed — try again.',
    state: 'Sign-in flow expired — try again.',
};

export function LoginPage() {
    const [params] = useSearchParams();
    const error = params.get('error');
    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
            <div className="text-center">
                <h1 className="text-2xl font-semibold tracking-tight">morelli</h1>
                <p className="mt-1 text-sm text-zinc-400">PCBJam screenshot review &amp; promotion</p>
            </div>
            {error && <p className="max-w-sm rounded border border-red-900 bg-red-950/50 px-4 py-2 text-center text-sm text-red-300">{ERRORS[error] ?? 'Sign-in failed.'}</p>}
            <a
                href="/api/auth/login"
                className="rounded-md bg-zinc-100 px-5 py-2.5 text-sm font-medium text-zinc-900 hover:bg-white"
            >
                Continue with GitHub
            </a>
        </div>
    );
}
