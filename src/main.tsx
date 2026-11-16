import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { Layout } from './components/Layout';
import { FeedbackProvider, Splash } from './components/ui';
import { ApiError, useMe } from './lib/api';
import { Home } from './pages/Home';
import { Consent, Login } from './pages/Login';
import { ProjectPage } from './pages/Project';
import { ProjectHome } from './pages/ProjectHome';
import { Projects } from './pages/Projects';
import { Settings } from './pages/Settings';
import { CalendarPage } from './pages/Calendar';

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
  if (!me.data) return <Login />;
  if (me.data.consentRequired) return <Consent user={me.data} />;
  return (
    <Routes>
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
