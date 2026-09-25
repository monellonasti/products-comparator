import { useState } from 'react';
import { useAuth } from '../auth';
import { ErrorNotice, useDocumentTitle } from '../components/ui';

export function LoginPage() {
  useDocumentTitle('Accesso');
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="login-wrap">
      <form
        className="card login-card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await login(email, password);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Catalogo fornitori</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Accesso riservato al personale autorizzato
          </p>
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <ErrorNotice error={error} />
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
          {busy ? 'Accesso in corso…' : 'Accedi'}
        </button>
      </form>
    </div>
  );
}
