import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrowserRouter, Link, Navigate, NavLink, Outlet, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api } from './api';
import type { Me, PipelineInfo } from './api';
import { PIPELINES, isPipeline } from '../shared/schemas';
import { LoginPage } from './pages/LoginPage';
import { RunsPage } from './pages/RunsPage';
import { RunComparePage } from './pages/RunComparePage';
import { BaselinesPage } from './pages/BaselinesPage';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            retry: (failureCount, error) => !(error instanceof ApiError && error.status < 500) && failureCount < 2,
            staleTime: 15_000,
        },
    },
});

function RequireAuth() {
    const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me') });
    if (me.isPending) return <p className="p-8 text-zinc-400">Loading…</p>;
    if (me.isError) return <Navigate to="/login" replace />;
    return <Layout email={me.data.email} />;
}

function Layout({ email }: { email: string }) {
    const params = useParams();
    const pipeline = params.pipeline && isPipeline(params.pipeline) ? params.pipeline : 'pcbjam';
    const navigate = useNavigate();
    const qc = useQueryClient();
    const pipelines = useQuery({
        queryKey: ['pipelines'],
        queryFn: () => api<{ pipelines: PipelineInfo[] }>('/pipelines'),
    });

    const logout = async () => {
        await api('/auth/logout', { method: 'POST' });
        qc.clear();
        navigate('/login');
    };

    const tab = ({ isActive }: { isActive: boolean }) =>
        `rounded px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`;

    return (
        <div className="min-h-screen">
            <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-zinc-800 bg-zinc-950/95 px-4 py-2 backdrop-blur">
                <Link to="/" className="text-base font-semibold tracking-tight text-zinc-100">
                    morelli
                </Link>
                <select
                    className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
                    value={pipeline}
                    onChange={(e) => navigate(`/${e.target.value}/runs`)}
                    title="Pipeline"
                >
                    {PIPELINES.map((p) => {
                        const info = pipelines.data?.pipelines.find((x) => x.id === p);
                        return (
                            <option key={p} value={p}>
                                {p}
                                {info ? ` · ${info.baselineCount} baselines` : ''}
                            </option>
                        );
                    })}
                </select>
                <nav className="flex gap-1">
                    <NavLink to={`/${pipeline}/runs`} className={tab}>
                        Runs
                    </NavLink>
                    <NavLink to={`/${pipeline}/baselines`} className={tab}>
                        Baselines
                    </NavLink>
                </nav>
                <div className="ml-auto flex items-center gap-3 text-sm text-zinc-400">
                    <span>{email}</span>
                    <button onClick={() => void logout()} className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800">
                        Sign out
                    </button>
                </div>
            </header>
            <main className="mx-auto max-w-screen-2xl p-4">
                <Outlet />
            </main>
        </div>
    );
}

export function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <BrowserRouter>
                <Routes>
                    <Route path="/login" element={<LoginPage />} />
                    <Route element={<RequireAuth />}>
                        <Route path="/" element={<Navigate to="/pcbjam/runs" replace />} />
                        <Route path="/:pipeline/runs" element={<RunsPage />} />
                        <Route path="/:pipeline/runs/:runId" element={<RunComparePage />} />
                        <Route path="/:pipeline/baselines" element={<BaselinesPage />} />
                        <Route path="*" element={<p className="text-zinc-400">Not found.</p>} />
                    </Route>
                </Routes>
            </BrowserRouter>
        </QueryClientProvider>
    );
}
