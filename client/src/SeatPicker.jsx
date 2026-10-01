import { useEffect, useState } from 'react';

// Props: bus, date, token, onBooked. Local state: booked seats, picked seats, error.
export default function SeatPicker({ bus, date, token, onBooked }) {
  const [booked, setBooked] = useState([]);
  const [picked, setPicked] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/buses/${bus._id}/seats?date=${date}`)
      .then((r) => r.json())
      .then((d) => setBooked(d.booked));
  }, [bus._id, date]);

  const toggle = (n) =>
    setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));

  const book = async () => {
    setError('');
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ busId: bus._id, date, seats: picked }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error);
    onBooked();
  };

  return (
    <div className="picker">
      <div className="seats">
        {Array.from({ length: bus.totalSeats }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            disabled={booked.includes(n)}
            className={picked.includes(n) ? 'seat on' : 'seat'}
            onClick={() => toggle(n)}
            aria-pressed={picked.includes(n)}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="summary">
        <p>
          {picked.length
            ? `Seats ${picked.sort((a, b) => a - b).join(', ')} · ₹${picked.length * bus.price}`
            : 'Pick one or more seats'}
        </p>
        {error && <p className="err">{error}</p>}
        <button className="primary" disabled={!picked.length} onClick={book}>
          Confirm booking
        </button>
      </div>
    </div>
  );
}
