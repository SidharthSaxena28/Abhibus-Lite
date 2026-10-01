import { useEffect, useRef, useState } from 'react';

// Live seat map: the server pushes bookings and other travellers' seat holds over Server-Sent Events.
export default function SeatPicker({ bus, date, token, onBooked }) {
  const me = useRef(Math.random().toString(36).slice(2)).current; // identifies this browser tab to the server
  const [live, setLive] = useState({ booked: [], held: {} });
  const [picked, setPicked] = useState([]);
  const [group, setGroup] = useState(1);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const json = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  useEffect(() => {
    const es = new EventSource(`/api/buses/${bus._id}/stream?date=${date}`);
    es.onmessage = (e) => setLive(JSON.parse(e.data));
    return () => es.close();
  }, [bus._id, date]);

  useEffect(() => { // let everyone else see which seats I'm considering
    fetch(`/api/buses/${bus._id}/hold`, { method: 'POST', headers: json, body: JSON.stringify({ date, seats: picked, clientId: me }) });
  }, [picked]);

  const heldByOther = (n) => live.held[n] && live.held[n] !== me;
  const toggle = (n) => setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));
  const freeSeats = bus.totalSeats - live.booked.length;

  const suggest = async () => {
    setError(''); setMsg('');
    const r = await fetch(`/api/buses/${bus._id}/suggest?date=${date}&count=${group}&clientId=${me}`).then((x) => x.json());
    if (r.seats?.length) setPicked(r.seats);
    else setError(`No ${group} seats are available right now.`);
  };

  const book = async () => {
    setError(''); setMsg('');
    const res = await fetch('/api/bookings', { method: 'POST', headers: json, body: JSON.stringify({ busId: bus._id, date, seats: picked, clientId: me }) });
    const data = await res.json();
    if (!res.ok) return setError(data.error);
    onBooked();
  };

  const join = async () => {
    setError('');
    const res = await fetch('/api/waitlist', { method: 'POST', headers: json, body: JSON.stringify({ busId: bus._id, date, count: Number(group) }) });
    const data = await res.json();
    if (res.ok) setMsg(`You are #${data.position} on the waitlist. If someone cancels, we book seats for you automatically.`);
    else setError(data.error);
  };

  const share = () => {
    navigator.clipboard.writeText(`${location.origin}/?bus=${bus._id}&date=${date}`);
    setMsg('Link copied. Friends who open it see this seat map update live.');
  };

  return (
    <div className="picker">
      <div className="toolbar">
        <label>Travellers <input type="number" min="1" max="6" value={group} onChange={(e) => setGroup(Number(e.target.value) || 1)} /></label>
        <button className="link" onClick={suggest}>Suggest seats together</button>
        <button className="link" onClick={share}>Share live link</button>
      </div>
      <div className="seats">
        {Array.from({ length: bus.totalSeats }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            disabled={live.booked.includes(n) || heldByOther(n)}
            className={picked.includes(n) ? 'seat on' : heldByOther(n) ? 'seat held' : 'seat'}
            onClick={() => toggle(n)}
            aria-pressed={picked.includes(n)}
            title={heldByOther(n) ? 'Someone is choosing this seat' : undefined}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="summary">
        <p>
          {picked.length
            ? `Seats ${[...picked].sort((a, b) => a - b).join(', ')} · ₹${picked.length * bus.price}`
            : 'Pick seats, or let us suggest some. Orange seats are being chosen by someone else.'}
        </p>
        {error && <p className="err">{error}</p>}
        {msg && <p className="ok">{msg}</p>}
        <button className="primary" disabled={!picked.length} onClick={book}>Confirm booking</button>
        {freeSeats < group && <button className="link" onClick={join}>Only {freeSeats} seat(s) left. Join the waitlist for {group}</button>}
      </div>
    </div>
  );
}
