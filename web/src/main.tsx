import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './auth';
import { ApiError } from './api';
import { Layout } from './components/Layout';
import { Spinner, useDocumentTitle } from './components/ui';
import { LoginPage } from './pages/LoginPage';
import { CatalogPage } from './pages/CatalogPage';
import './styles.css';

const ProductPage = lazy(() => import('./pages/ProductPage'));
const PhotoResultsPage = lazy(() => import('./pages/PhotoResultsPage'));
const SuppliersPage = lazy(() => import('./pages/SuppliersPage'));
const SupplierDetailPage = lazy(() => import('./pages/SupplierDetailPage'));
const ImportsPage = lazy(() => import('./pages/ImportsPage'));
const ImportWizardPage = lazy(() => import('./pages/ImportWizardPage'));
const ImportDetailPage = lazy(() => import('./pages/ImportDetailPage'));
const ChangesPage = lazy(() => import('./pages/ChangesPage'));
const ReviewsPage = lazy(() => import('./pages/ReviewsPage'));
const ReviewDetailPage = lazy(() => import('./pages/ReviewDetailPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
  },
});

function Protected() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner />;
  // Remember the requested page (a shared link, an expired session) to return there after the login.
  if (!user) return <Navigate to="/accesso" replace state={{ from: location }} />;
  return <Layout />;
}

function LoginRoute() {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <LoginPage />;
  const from = (location.state as { from?: { pathname?: string; search?: string; hash?: string } } | null)?.from;
  const path = from?.pathname ?? '';
  const target = path.startsWith('/') && !path.startsWith('//') && path !== '/accesso' ? `${path}${from?.search ?? ''}${from?.hash ?? ''}` : '/';
  return <Navigate to={target} replace />;
}

function NotFound() {
  useDocumentTitle('Pagina non trovata');
  return (
    <div className="page">
      <h1>Pagina non trovata</h1>
      <p>
        L’indirizzo non corrisponde a nessuna pagina. <Link to="/">Torna al catalogo</Link>
      </p>
    </div>
  );
}

function App() {
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/accesso" element={<LoginRoute />} />
        <Route element={<Protected />}>
          <Route index element={<CatalogPage />} />
          <Route path="prodotti/:id" element={<ProductPage />} />
          <Route path="ricerca/:id" element={<PhotoResultsPage />} />
          <Route path="fornitori" element={<SuppliersPage />} />
          <Route path="fornitori/:id" element={<SupplierDetailPage />} />
          <Route path="importazioni" element={<ImportsPage />} />
          <Route path="importazioni/nuova" element={<ImportWizardPage />} />
          <Route path="importazioni/variazioni" element={<ChangesPage />} />
          <Route path="importazioni/:id" element={<ImportDetailPage />} />
          <Route path="corrispondenze" element={<ReviewsPage />} />
          <Route path="corrispondenze/:id" element={<ReviewDetailPage />} />
          <Route path="impostazioni" element={<SettingsPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
