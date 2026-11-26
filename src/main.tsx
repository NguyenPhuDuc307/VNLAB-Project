import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { Layout } from './components/Layout';
import { FeedbackProvider, Splash } from './components/ui';
import { ApiError, useMe } from './lib/api';
import { Consent, Login } from './pages/Login';

// Mỗi trang là một chunk riêng (tải khi vào route) — Gantt / Lịch / Cài đặt không nằm trong lần tải đầu.
const Home = lazy(() => import('./pages/Home').then((m) => ({ default: m.Home })));
const ProjectPage = lazy(() => import('./pages/Project').then((m) => ({ default: m.ProjectPage })));
const ProjectHome = lazy(() => import('./pages/ProjectHome').then((m) => ({ default: m.ProjectHome })));
const Projects = lazy(() => import('./pages/Projects').then((m) => ({ default: m.Projects })));
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const CalendarPage = lazy(() => import('./pages/Calendar').then((m) => ({ default: m.CalendarPage })));
const GetflyDonePage = lazy(() => import('./pages/GetflyDone').then((m) => ({ default: m.GetflyDonePage })));
const GetflyKpiPage = lazy(() => import('./pages/GetflyKpi').then((m) => ({ default: m.GetflyKpiPage })));

// Phiên hết hạn ở bất kỳ request nào -> hỏi lại /me, nó 401 thì hiện màn đăng nhập
// (màn đó tự đi SSO im lặng để kiểm role lại khi server đòi `reauth`).
const onError = (err: unknown) => {
  if (err instanceof ApiError && err.status === 401 && qc.getQueryData(['me'])) qc.resetQueries({ queryKey: ['me'] });
};

const qc: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: true, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 } },
});

function App() {
  const me = useMe();
  if (me.isPending) return <Splash />;
  if (!me.data) {
    // Cửa sổ cầu nối của bookmarklet Getfly mở rất nhỏ — cần đăng nhập thì phóng to cho dễ thao tác.
    if (window.opener && location.pathname.startsWith('/getfly-')) { try { window.resizeTo(480, 680); } catch { /* bỏ qua */ } }
    return <Login />;
  }
  if (me.data.consentRequired) return <Consent user={me.data} />;
  return (
    <Suspense fallback={<Splash />}>
    <Routes>
      {/* Cửa sổ bật lên của bookmarklet "Hoàn thành Getfly" — không có khung trang. */}
      <Route path="getfly-hoan-thanh" element={<GetflyDonePage />} />
      <Route path="getfly-kpi" element={<GetflyKpiPage />} />
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="du-an" element={<Projects />} />
        <Route path="du-an/:id" element={<ProjectHome />} />
        <Route path="du-an/:id/phase/:phase" element={<ProjectPage />} />
        <Route path="lich" element={<CalendarPage />} />
        <Route path="cai-dat" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    </Suspense>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <FeedbackProvider>
          <App />
        </FeedbackProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
