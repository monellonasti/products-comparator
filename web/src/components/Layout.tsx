import { NavLink, Outlet } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth';
import { api } from '../api';

export function Layout() {
  const { user, logout } = useAuth();
  const reviews = useQuery({
    queryKey: ['review-counts'],
    queryFn: () => api.get<{ openCounts: Record<string, number> }>('/api/reviews?status=open'),
    refetchInterval: 60_000,
  });
  const open = Object.values(reviews.data?.openCounts ?? {}).reduce((a, b) => a + b, 0);
  return (
    <>
      <a className="skip-link" href="#main">
        Vai al contenuto
      </a>
      <header className="app-header">
        <div className="app-header-inner">
          <NavLink to="/" className="brand" aria-label="Catalogo fornitori, pagina iniziale">
            <img src="/favicon.svg" width={24} height={24} alt="" /> <span className="brand-text">Catalogo fornitori</span>
          </NavLink>
          <nav className="main-nav" aria-label="Navigazione principale">
            <NavLink to="/" end>
              Catalogo
            </NavLink>
            <NavLink to="/fornitori">Fornitori</NavLink>
            <NavLink to="/importazioni">Importazioni</NavLink>
            <NavLink to="/corrispondenze">
              Corrispondenze da verificare {open > 0 && <span className="nav-count" aria-label={`${open} da verificare`}>{open}</span>}
            </NavLink>
            <NavLink to="/impostazioni">Impostazioni</NavLink>
          </nav>
          <div className="user-menu">
            <span className="user-name">
              {user?.displayName} · {user?.role === 'admin' ? 'amministratore' : 'operatore'}
            </span>
            <button onClick={() => void logout()}>Esci</button>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
