import { createContext, useContext, useEffect, useState } from 'react';
import SeatPicker from './SeatPicker.jsx';

// ---------- Auth context (Context API + localStorage) ----------
const AuthCtx = createContext();
const useAuth = () => useContext(AuthCtx);

const post = async (path, body) => {
  const res = await fetch('/api' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
};

function AuthForm() {
  const { login } = useAuth();
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    try {
      login(await post(`/auth/${mode}`, f));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <form className="card auth" onSubmit={submit}>
      <h2>{mode === 'login' ? 'Log in to book' : 'Create your account'}</h2>
      {mode === 'register' && <input placeholder="Full name" value={f.name} onChange={set('name')} required />}
      <input type="email" placeholder="Email" value={f.email} onChange={set('email')} required />
      <input type="password" placeholder="Password (6+ characters)" value={f.password} onChange={set('password')} required />
      {error && <p className="err">{error}</p>}
      <button className="primary">{mode === 'login' ? 'Log in' : 'Sign up'}</button>
      <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'New here? Sign up' : 'Have an account? Log in'}
      </button>
    </form>
  );
}

function BusCard({ bus, onSelect, active }) {
  return (
    <div className={active ? 'card bus active' : 'card bus'}>
      <div>
        <strong>{bus.operator}</strong>
        <small>{bus.type}</small>
      </div>
      <div className="times">{bus.departs} → {bus.arrives}</div>
      <div className="price">₹{bus.price}</div>
      <button className="primary" onClick={() => onSelect(bus)}>Select seats</button>
    </div>
  );
}

function Trips() {
  const { token } = useAuth();
  const [trips, setTrips] = useState(null);
  useEffect(() => {
    fetch('/api/bookings', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then(setTrips);
  }, [token]);

  if (!trips) return <p>Loading your trips…</p>;
  if (!trips.length) return <p>No trips yet. Search a route to book your first one.</p>;
  return trips.map((t) => (
    <div className="card bus" key={t._id}>
      <div><strong>{t.bus?.from} to {t.bus?.to}</strong><small>{t.bus?.operator}</small></div>
      <div className="times">{t.date}</div>
      <div>Seats {t.seats.join(', ')}</div>
      <div className="price">₹{t.total}</div>
    </div>
  ));
}

function Main() {
  const { user, token, logout } = useAuth();
  const [view, setView] = useState('search');
  const [q, setQ] = useState({ from: 'Hyderabad', to: 'Bengaluru', date: new Date().toISOString().slice(0, 10) });
  const [buses, setBuses] = useState(null);
  const [bus, setBus] = useState(null);
  const [done, setDone] = useState(false);
  const set = (k) => (e) => setQ({ ...q, [k]: e.target.value });

  const search = async (e) => {
    e.preventDefault();
    setBus(null);
    setDone(false);
    const params = new URLSearchParams({ from: q.from, to: q.to });
    setBuses(await fetch('/api/buses?' + params).then((r) => r.json()));
  };

  return (
    <>
      <header>
        <h1>Abhibus Lite</h1>
        <nav>
          <button className="link" onClick={() => setView('search')}>Search</button>
          {user && <button className="link" onClick={() => setView('trips')}>My trips</button>}
          {user && <button className="link" onClick={logout}>Log out ({user.name})</button>}
        </nav>
      </header>
      <main>
        {view === 'trips' ? <Trips /> : (
          <>
            <form className="card search" onSubmit={search}>
              <input placeholder="From" value={q.from} onChange={set('from')} />
              <input placeholder="To" value={q.to} onChange={set('to')} />
              <input type="date" value={q.date} onChange={set('date')} min={new Date().toISOString().slice(0, 10)} />
              <button className="primary">Search buses</button>
            </form>
            {done && <p className="ok">Booked! Find it under My trips.</p>}
            {buses && !buses.length && <p>No buses on this route. Try Hyderabad to Bengaluru.</p>}
            {buses?.map((b) => (
              <div key={b._id}>
                <BusCard bus={b} active={bus?._id === b._id} onSelect={setBus} />
                {bus?._id === b._id && (token
                  ? <SeatPicker bus={b} date={q.date} token={token} onBooked={() => { setBus(null); setDone(true); }} />
                  : <AuthForm />)}
              </div>
            ))}
          </>
        )}
      </main>
    </>
  );
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [user, setUser] = useState(JSON.parse(localStorage.getItem('user') || 'null'));

  const login = (d) => {
    localStorage.setItem('token', d.token);
    localStorage.setItem('user', JSON.stringify(d.user));
    setToken(d.token);
    setUser(d.user);
  };
  const logout = () => {
    localStorage.clear();
    setToken(null);
    setUser(null);
  };

  return (
    <AuthCtx.Provider value={{ token, user, login, logout }}>
      <Main />
    </AuthCtx.Provider>
  );
}
