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

const hm = (m) => `${Math.floor(m / 60)}h ${m % 60}m`;

function TripCard({ trip, onSelect }) {
  const [a, b] = trip.legs.map((l) => l.bus);
  return (
    <div className="card bus">
      <div>
        <strong>{a.from} → {trip.via} → {b.to}</strong>
        <small>{a.operator} {a.departs}, then {b.operator} {b.departs}</small>
      </div>
      <div className="times">{hm(trip.totalMinutes)} total<small>{hm(trip.layoverMinutes)} layover in {trip.via}</small></div>
      <div className="price">₹{trip.totalPrice}</div>
      <button className="primary" onClick={() => onSelect(trip)}>Book both legs</button>
    </div>
  );
}

function Trips() {
  const { token } = useAuth();
  const [trips, setTrips] = useState(null);
  const [wait, setWait] = useState([]);
  const h = { Authorization: `Bearer ${token}` };
  const load = () => {
    fetch('/api/bookings', { headers: h }).then((r) => r.json()).then(setTrips);
    fetch('/api/waitlist', { headers: h }).then((r) => r.json()).then(setWait);
  };
  useEffect(load, [token]);
  const cancel = async (url) => {
    await fetch(url, { method: 'DELETE', headers: h });
    load();
  };

  if (!trips) return <p>Loading your trips…</p>;
  const waiting = wait.filter((w) => w.status !== 'cancelled');
  return (
    <>
      {!trips.length && <p>No trips yet. Search a route to book your first one.</p>}
      {trips.map((t) => (
        <div className="card bus" key={t._id}>
          <div><strong>{t.bus?.from} to {t.bus?.to}</strong><small>{t.bus?.operator}</small></div>
          <div className="times">{t.date}</div>
          <div className="price">Seats {t.seats.join(', ')} · ₹{t.total}</div>
          <button className="link" onClick={() => cancel('/api/bookings/' + t._id)}>Cancel</button>
        </div>
      ))}
      {waiting.length > 0 && <h3>Waitlist</h3>}
      {waiting.map((w) => (
        <div className="card bus" key={w._id}>
          <div><strong>{w.bus.from} to {w.bus.to}</strong><small>{w.bus.operator}</small></div>
          <div className="times">{w.date}</div>
          <div>{w.status === 'waiting' ? `#${w.position} in line for ${w.count} seat(s)` : 'Confirmed: see your trips'}</div>
          {w.status === 'waiting' && <button className="link" onClick={() => cancel('/api/waitlist/' + w._id)}>Leave</button>}
        </div>
      ))}
    </>
  );
}

function Main() {
  const { user, token, logout } = useAuth();
  const [view, setView] = useState('search');
  const [q, setQ] = useState({ from: 'Hyderabad', to: 'Bengaluru', date: new Date().toISOString().slice(0, 10) });
  const [buses, setBuses] = useState(null);
  const [bus, setBus] = useState(null);
  const [done, setDone] = useState(false);
  const [trips, setTrips] = useState(null);
  const [conn, setConn] = useState(null);
  const set = (k) => (e) => setQ({ ...q, [k]: e.target.value });

  useEffect(() => { // shared link (?bus=ID&date=YYYY-MM-DD) opens that bus's live seat map
    const p = new URLSearchParams(location.search);
    if (!p.get('bus')) return;
    fetch('/api/buses/' + p.get('bus')).then((r) => (r.ok ? r.json() : null)).then((b) => {
      if (!b) return;
      if (p.get('date')) setQ((x) => ({ ...x, date: p.get('date') }));
      setBuses([b]);
      setBus(b);
    });
  }, []);

  const search = async (e) => {
    e.preventDefault();
    setBus(null);
    setConn(null);
    setDone(false);
    const params = new URLSearchParams({ from: q.from, to: q.to });
    setBuses(await fetch('/api/buses?' + params).then((r) => r.json()));
    const found = await fetch('/api/connections?' + new URLSearchParams(q)).then((r) => r.json());
    setTrips(Array.isArray(found) ? found : []);
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
            {buses && !buses.length && !trips?.length && <p>No buses on this route. Try Hyderabad to Chennai.</p>}
            {buses?.map((b) => (
              <div key={b._id}>
                <BusCard bus={b} active={bus?._id === b._id} onSelect={(b2) => { setConn(null); setBus(b2); }} />
                {bus?._id === b._id && (token
                  ? <SeatPicker bus={b} date={q.date} token={token} onBooked={() => { setBus(null); setDone(true); }} />
                  : <AuthForm />)}
              </div>
            ))}
            {trips?.length > 0 && <h3>With a transfer</h3>}
            {trips?.map((t, i) => (
              <div key={i}>
                <TripCard trip={t} onSelect={(trip) => { setBus(null); setConn({ trip, leg: 0 }); }} />
                {conn?.trip === t && (token ? (
                  <>
                    <p className="ok">Leg {conn.leg + 1} of 2: {t.legs[conn.leg].bus.from} → {t.legs[conn.leg].bus.to} on {t.legs[conn.leg].date}</p>
                    <SeatPicker key={conn.leg} bus={t.legs[conn.leg].bus} date={t.legs[conn.leg].date} token={token}
                      onBooked={() => (conn.leg === 0 ? setConn({ ...conn, leg: 1 }) : (setConn(null), setDone(true)))} />
                  </>
                ) : <AuthForm />)}
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
