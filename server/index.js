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

app.get('/api/buses/:id/seats', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT seat_no FROM booking_seats WHERE bus_id = ? AND travel_date = ?',
    [req.params.id, req.query.date]);
  res.json({ booked: rows.map((r) => r.seat_no) });
}));

app.post('/api/bookings', auth, wrap(async (req, res) => {
  const { busId, date, seats } = req.body;
  const [[bus]] = await pool.query('SELECT * FROM buses WHERE id = ?', [busId]);
  const valid = bus && date && Array.isArray(seats) && seats.length &&
    seats.every((s) => Number.isInteger(s) && s >= 1 && s <= bus.total_seats);
  if (!valid) return res.status(400).json({ error: 'Bus, date and valid seat numbers are required' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query('INSERT INTO bookings (user_id, bus_id, travel_date, total) VALUES (?, ?, ?, ?)',
      [req.uid, busId, date, bus.price * seats.length]);
    await conn.query('INSERT INTO booking_seats (booking_id, bus_id, travel_date, seat_no) VALUES ?',
      [seats.map((s) => [r.insertId, busId, date, s])]);
    await conn.commit();
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
];

const seed = [
  ['Orange Travels', 'AC Sleeper', 'Hyderabad', 'Bengaluru', '21:30', '06:00', 1100],
  ['VRL Travels', 'Volvo Multi-Axle', 'Hyderabad', 'Bengaluru', '20:00', '05:15', 1350],
  ['SRS Travels', 'Non-AC Seater', 'Hyderabad', 'Bengaluru', '22:15', '07:30', 750],
  ['KSRTC', 'Airavat Club', 'Bengaluru', 'Chennai', '23:00', '05:00', 650],
  ['Parveen Travels', 'AC Sleeper', 'Chennai', 'Bengaluru', '22:00', '04:30', 900],
  ['Kaveri Travels', 'AC Seater', 'Delhi', 'Jaipur', '07:00', '12:30', 550],
];

async function init() {
  const boot = await mysql.createConnection(cfg);
  await boot.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\``);
  await boot.end();
  pool = mysql.createPool({ ...cfg, database: DB, dateStrings: true });
  for (const sql of schema) await pool.query(sql);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM buses');
  if (!n) await pool.query(
    'INSERT INTO buses (operator, type, from_city, to_city, departs, arrives, price) VALUES ?', [seed]);
  return pool;
}

// Start the server only when run directly (`npm start`), not when imported by tests
if (require.main === module) {
  init()
    .then(() => app.listen(process.env.PORT || 5001, () => console.log('API on :5001')))
    .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
}

module.exports = { app, init, getPool: () => pool };
