const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DB = process.env.DB_NAME || 'abhibus_lite';
const cfg = {
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
};
let pool;

// ---------- Helpers ----------
const sign = (id) => jwt.sign({ id }, SECRET, { expiresIn: '7d' });
const auth = (req, res, next) => {
  try {
    req.uid = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET).id;
    next();
  } catch {
    res.status(401).json({ error: 'Please log in to continue' });
  }
};
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(500).json({ error: e.message }));

// ---------- Connecting routes ----------
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const duration = (b) => (toMin(b.arrives) - toMin(b.departs) + 1440) % 1440;
const addDays = (d, n) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

// Can bus b follow bus a? Returns the itinerary, or null if the layover is too short or too long.
// Buses run daily; if the connection is missed today, the next departure is tomorrow (usually too long a wait).
function plan(a, b, date, minLayover = 60, maxLayover = 480) {
  const arrive = toMin(a.departs) + duration(a); // minutes after midnight of the travel date
  const wait = ((toMin(b.departs) - arrive - minLayover) % 1440 + 1440) % 1440 + minLayover;
  if (wait > maxLayover) return null;
  return {
    legs: [{ bus: a, date }, { bus: b, date: addDays(date, Math.floor((arrive + wait) / 1440)) }],
    via: a.to, layoverMinutes: wait,
    totalMinutes: duration(a) + wait + duration(b), totalPrice: a.price + b.price,
  };
}
const BUS_COLS = 'id AS _id, operator, type, from_city AS `from`, to_city AS `to`, departs, arrives, price, total_seats AS totalSeats';

// ---------- Seat suggestions ----------
// Picks n free seats: fewest rows spanned (4 seats per row), then tightest together, then nearest the front.
function suggestSeats(total, taken, n, cols = 4) {
  const free = [];
  for (let s = 1; s <= total; s++) if (!taken.includes(s)) free.push(s);
  if (!Number.isInteger(n) || n < 1 || free.length < n) return [];
  let best = null;
  for (let i = 0; i + n <= free.length; i++) {
    const win = free.slice(i, i + n);
    const rows = new Set(win.map((s) => Math.floor((s - 1) / cols))).size;
    const score = rows * 1000 + (win[n - 1] - win[0]) * 10 + win[0] / 100;
    if (!best || score < best.score) best = { score, win };
  }
  return best.win;
}

// ---------- Live seat map: Server-Sent Events + short-lived seat holds ----------
const HOLD_MS = 2 * 60 * 1000;
const holds = new Map();    // "busId:date" -> Map(clientId -> { seats, expires })
const watchers = new Map(); // "busId:date" -> Set of open response streams
const key = (b, d) => `${b}:${d}`;

async function snapshot(busId, date) {
  const [rows] = await pool.query('SELECT seat_no FROM booking_seats WHERE bus_id = ? AND travel_date = ?', [busId, date]);
  const mine = holds.get(key(busId, date)) || new Map();
  const held = {}; // seat -> clientId holding it
  for (const [id, h] of mine) {
    if (h.expires < Date.now()) mine.delete(id);
    else h.seats.forEach((s) => { held[s] = id; });
  }
  return { booked: rows.map((r) => r.seat_no), held };
}

async function broadcast(busId, date) {
  try {
    const set = watchers.get(key(busId, date));
    if (!set || !set.size) return;
    const msg = `data: ${JSON.stringify(await snapshot(busId, date))}\n\n`;
    set.forEach((res) => res.write(msg));
  } catch { /* live updates are best-effort */ }
}

// ---------- Waitlist: when seats free up, book the first people in line ----------
async function promoteWaitlist(conn, busId, date) {
  const [[bus]] = await conn.query('SELECT * FROM buses WHERE id = ?', [busId]);
  const [queue] = await conn.query(
    "SELECT * FROM waitlist WHERE bus_id = ? AND travel_date = ? AND status = 'waiting' ORDER BY id FOR UPDATE", [busId, date]);
  const promoted = [];
  for (const w of queue) {
    const [taken] = await conn.query('SELECT seat_no FROM booking_seats WHERE bus_id = ? AND travel_date = ?', [busId, date]);
    const seats = suggestSeats(bus.total_seats, taken.map((r) => r.seat_no), w.seats_needed);
    if (!seats.length) continue; // not enough seats for this group yet; the next in line may still fit
    const [r] = await conn.query('INSERT INTO bookings (user_id, bus_id, travel_date, total) VALUES (?, ?, ?, ?)',
      [w.user_id, busId, date, bus.price * seats.length]);
    await conn.query('INSERT INTO booking_seats (booking_id, bus_id, travel_date, seat_no) VALUES ?',
      [seats.map((s) => [r.insertId, busId, date, s])]);
    await conn.query("UPDATE waitlist SET status = 'confirmed', booking_id = ? WHERE id = ?", [r.insertId, w.id]);
    promoted.push({ waitlistId: w.id, seats });
  }
  return promoted;
}

// ---------- App ----------
const app = express();
app.use(cors(), express.json());

app.post('/api/auth/register', wrap(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || (password || '').length < 6)
    return res.status(400).json({ error: 'Name, email and a 6+ character password are required' });
  try {
    const [r] = await pool.query('INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
      [name, email.toLowerCase(), await bcrypt.hash(password, 10)]);
    res.status(201).json({ token: sign(r.insertId), user: { name, email } });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email already registered' });
    throw e;
  }
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const [[u]] = await pool.query('SELECT * FROM users WHERE email = ?', [(req.body.email || '').toLowerCase()]);
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password)))
    return res.status(401).json({ error: 'Wrong email or password' });
  res.json({ token: sign(u.id), user: { name: u.name, email: u.email } });
}));

app.get('/api/buses', wrap(async (req, res) => {
  const { from = '', to = '' } = req.query;
  const [rows] = await pool.query(
    `SELECT id AS _id, operator, type, from_city AS \`from\`, to_city AS \`to\`,
            departs, arrives, price, total_seats AS totalSeats
     FROM buses WHERE from_city LIKE ? AND to_city LIKE ? ORDER BY price`,
    [`%${from.trim()}%`, `%${to.trim()}%`]);
  res.json(rows);
}));

app.get('/api/connections', wrap(async (req, res) => {
  const { from = '', to = '', date = '' } = req.query;
  if (!from.trim() || !to.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'from, to and date (YYYY-MM-DD) are required' });
  const f = `%${from.trim()}%`, t = `%${to.trim()}%`;
  const [first] = await pool.query(`SELECT ${BUS_COLS} FROM buses WHERE from_city LIKE ? AND to_city NOT LIKE ?`, [f, t]);
  const [second] = await pool.query(`SELECT ${BUS_COLS} FROM buses WHERE to_city LIKE ? AND from_city NOT LIKE ?`, [t, f]);
  const trips = [];
  for (const a of first) for (const b of second) {
    if (a.to.toLowerCase() !== b.from.toLowerCase()) continue;
    const trip = plan(a, b, date);
    if (trip) trips.push(trip);
  }
  res.json(trips.sort((x, y) => x.totalMinutes - y.totalMinutes).slice(0, 10));
}));

app.get('/api/buses/:id', wrap(async (req, res) => {
  const [[bus]] = await pool.query(`SELECT ${BUS_COLS} FROM buses WHERE id = ?`, [req.params.id]);
  bus ? res.json(bus) : res.status(404).json({ error: 'Bus not found' });
}));

app.get('/api/buses/:id/stream', (req, res) => {
  const k = key(req.params.id, req.query.date);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  if (!watchers.has(k)) watchers.set(k, new Set());
  watchers.get(k).add(res);
  snapshot(req.params.id, req.query.date).then((s) => res.write(`data: ${JSON.stringify(s)}\n\n`));
  req.on('close', () => watchers.get(k).delete(res));
});

app.post('/api/buses/:id/hold', wrap(async (req, res) => {
  const { date, seats = [], clientId } = req.body;
  if (!date || !clientId) return res.status(400).json({ error: 'date and clientId are required' });
  const k = key(req.params.id, date);
  if (!holds.has(k)) holds.set(k, new Map());
  const snap = await snapshot(req.params.id, date);
  const ok = seats.filter((s) => Number.isInteger(s) && !snap.booked.includes(s) && (!snap.held[s] || snap.held[s] === clientId));
  if (ok.length) holds.get(k).set(clientId, { seats: ok, expires: Date.now() + HOLD_MS });
  else holds.get(k).delete(clientId);
  await broadcast(req.params.id, date);
  res.json({ held: ok });
}));

app.get('/api/buses/:id/suggest', wrap(async (req, res) => {
  const [[bus]] = await pool.query('SELECT total_seats FROM buses WHERE id = ?', [req.params.id]);
  if (!bus) return res.status(404).json({ error: 'Bus not found' });
  const snap = await snapshot(req.params.id, req.query.date);
  const othersHeld = Object.keys(snap.held).filter((s) => snap.held[s] !== req.query.clientId).map(Number);
  res.json({ seats: suggestSeats(bus.total_seats, [...snap.booked, ...othersHeld], Number(req.query.count)) });
}));

app.get('/api/buses/:id/seats', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT seat_no FROM booking_seats WHERE bus_id = ? AND travel_date = ?',
    [req.params.id, req.query.date]);
  res.json({ booked: rows.map((r) => r.seat_no) });
}));

app.post('/api/bookings', auth, wrap(async (req, res) => {
  const { busId, date, seats, clientId } = req.body;
  const [[bus]] = await pool.query('SELECT * FROM buses WHERE id = ?', [busId]);
  const valid = bus && date && Array.isArray(seats) && seats.length &&
    seats.every((s) => Number.isInteger(s) && s >= 1 && s <= bus.total_seats);
  if (!valid) return res.status(400).json({ error: 'Bus, date and valid seat numbers are required' });

  const snap = await snapshot(busId, date);
  if (seats.some((s) => snap.held[s] && snap.held[s] !== clientId))
    return res.status(409).json({ error: 'Another traveller is holding one of those seats right now.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query('INSERT INTO bookings (user_id, bus_id, travel_date, total) VALUES (?, ?, ?, ?)',
      [req.uid, busId, date, bus.price * seats.length]);
    await conn.query('INSERT INTO booking_seats (booking_id, bus_id, travel_date, seat_no) VALUES ?',
      [seats.map((s) => [r.insertId, busId, date, s])]);
    await conn.commit();
    holds.get(key(busId, date))?.delete(clientId);
    broadcast(busId, date);
    res.status(201).json({ _id: r.insertId });
  } catch (e) {
    await conn.rollback();
    // The UNIQUE key on (bus_id, travel_date, seat_no) makes double-booking impossible
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'One of those seats was just booked. Pick another.' });
    throw e;
  } finally {
    conn.release();
  }
}));

app.get('/api/bookings', auth, wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT b.id, b.travel_date, b.total, bu.operator, bu.from_city, bu.to_city,
            GROUP_CONCAT(s.seat_no ORDER BY s.seat_no) AS seats
     FROM bookings b
     JOIN buses bu ON bu.id = b.bus_id
     JOIN booking_seats s ON s.booking_id = b.id
     WHERE b.user_id = ?
     GROUP BY b.id, b.travel_date, b.total, bu.operator, bu.from_city, bu.to_city
     ORDER BY b.id DESC`, [req.uid]);
  res.json(rows.map((r) => ({
    _id: r.id, date: r.travel_date, total: r.total,
    seats: r.seats.split(',').map(Number),
    bus: { operator: r.operator, from: r.from_city, to: r.to_city },
  })));
}));

app.delete('/api/bookings/:id', auth, wrap(async (req, res) => {
  const conn = await pool.getConnection();
  let booking, promoted;
  try {
    await conn.beginTransaction();
    [[booking]] = await conn.query('SELECT * FROM bookings WHERE id = ? AND user_id = ? FOR UPDATE', [req.params.id, req.uid]);
    if (!booking) { await conn.rollback(); return res.status(404).json({ error: 'Booking not found' }); }
    await conn.query('DELETE FROM booking_seats WHERE booking_id = ?', [booking.id]);
    await conn.query('DELETE FROM bookings WHERE id = ?', [booking.id]);
    await conn.query("UPDATE waitlist SET status = 'cancelled' WHERE booking_id = ?", [booking.id]);
    promoted = await promoteWaitlist(conn, booking.bus_id, booking.travel_date); // freed seats go to the queue, same transaction
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  broadcast(booking.bus_id, booking.travel_date);
  res.json({ cancelled: booking.id, promoted });
}));

app.post('/api/waitlist', auth, wrap(async (req, res) => {
  const { busId, date, count } = req.body;
  const [[bus]] = await pool.query('SELECT id FROM buses WHERE id = ?', [busId]);
  if (!bus || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isInteger(count) || count < 1 || count > 6)
    return res.status(400).json({ error: 'Bus, date and a seat count of 1 to 6 are required' });
  const [r] = await pool.query('INSERT INTO waitlist (user_id, bus_id, travel_date, seats_needed) VALUES (?, ?, ?, ?)',
    [req.uid, busId, date, count]);
  const [[{ position }]] = await pool.query(
    "SELECT COUNT(*) AS position FROM waitlist WHERE bus_id = ? AND travel_date = ? AND status = 'waiting' AND id <= ?", [busId, date, r.insertId]);
  res.status(201).json({ _id: r.insertId, position });
}));

app.get('/api/waitlist', auth, wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT w.id, w.travel_date, w.seats_needed, w.status, bu.operator, bu.from_city, bu.to_city,
            (SELECT COUNT(*) FROM waitlist x WHERE x.bus_id = w.bus_id AND x.travel_date = w.travel_date
               AND x.status = 'waiting' AND x.id <= w.id) AS position
     FROM waitlist w JOIN buses bu ON bu.id = w.bus_id WHERE w.user_id = ? ORDER BY w.id DESC`, [req.uid]);
  res.json(rows.map((r) => ({
    _id: r.id, date: r.travel_date, count: r.seats_needed, status: r.status, position: r.position,
    bus: { operator: r.operator, from: r.from_city, to: r.to_city },
  })));
}));

app.delete('/api/waitlist/:id', auth, wrap(async (req, res) => {
  const [r] = await pool.query("UPDATE waitlist SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'waiting'",
    [req.params.id, req.uid]);
  r.affectedRows ? res.json({ cancelled: Number(req.params.id) }) : res.status(404).json({ error: 'Waitlist entry not found' });
}));

// ---------- Schema, seed data, start ----------
const schema = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE, password VARCHAR(100) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS buses (
    id INT AUTO_INCREMENT PRIMARY KEY, operator VARCHAR(100), type VARCHAR(50),
    from_city VARCHAR(80), to_city VARCHAR(80), departs VARCHAR(5), arrives VARCHAR(5),
    price INT, total_seats INT DEFAULT 24)`,
  `CREATE TABLE IF NOT EXISTS bookings (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, bus_id INT NOT NULL,
    travel_date DATE NOT NULL, total INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (bus_id) REFERENCES buses(id))`,
  `CREATE TABLE IF NOT EXISTS booking_seats (
    booking_id INT NOT NULL, bus_id INT NOT NULL, travel_date DATE NOT NULL, seat_no INT NOT NULL,
    UNIQUE KEY one_seat_per_trip (bus_id, travel_date, seat_no),
    FOREIGN KEY (booking_id) REFERENCES bookings(id))`,
  `CREATE TABLE IF NOT EXISTS waitlist (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, bus_id INT NOT NULL,
    travel_date DATE NOT NULL, seats_needed INT NOT NULL, status VARCHAR(10) NOT NULL DEFAULT 'waiting',
    booking_id INT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (bus_id) REFERENCES buses(id))`,
];

const seed = [
  ['Orange Travels', 'AC Sleeper', 'Hyderabad', 'Bengaluru', '21:30', '06:00', 1100],
  ['VRL Travels', 'Volvo Multi-Axle', 'Hyderabad', 'Bengaluru', '20:00', '05:15', 1350],
  ['SRS Travels', 'Non-AC Seater', 'Hyderabad', 'Bengaluru', '22:15', '07:30', 750],
  ['KSRTC', 'Airavat Club', 'Bengaluru', 'Chennai', '23:00', '05:00', 650],
  ['Parveen Travels', 'AC Sleeper', 'Chennai', 'Bengaluru', '22:00', '04:30', 900],
  ['Kaveri Travels', 'AC Seater', 'Delhi', 'Jaipur', '07:00', '12:30', 550],
  ['KSRTC', 'Express', 'Bengaluru', 'Chennai', '08:30', '14:00', 500],
  ['SRS Travels', 'AC Seater', 'Bengaluru', 'Chennai', '10:00', '15:30', 600],
  ['Parveen Travels', 'Non-AC Seater', 'Bengaluru', 'Chennai', '14:00', '19:30', 450],
];

async function init() {
  const boot = await mysql.createConnection(cfg);
  await boot.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\``);
  await boot.end();
  pool = mysql.createPool({ ...cfg, database: DB, dateStrings: true });
  for (const sql of schema) await pool.query(sql);
  for (const r of seed) { // add any sample bus that is missing, so existing databases get new routes too
    const [[x]] = await pool.query(
      'SELECT COUNT(*) AS n FROM buses WHERE operator = ? AND from_city = ? AND to_city = ? AND departs = ?',
      [r[0], r[2], r[3], r[4]]);
    if (!x.n) await pool.query(
      'INSERT INTO buses (operator, type, from_city, to_city, departs, arrives, price) VALUES (?)', [r]);
  }
  return pool;
}

// Start the server only when run directly (`npm start`), not when imported by tests
if (require.main === module) {
  init()
    .then(() => app.listen(process.env.PORT || 5001, () => console.log('API on :5001')))
    .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
}

module.exports = { app, init, getPool: () => pool, plan, suggestSeats };
