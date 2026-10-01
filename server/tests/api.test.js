// Integration tests: run against a separate database so real data is never touched.
process.env.DB_NAME = 'abhibus_lite_test';
const request = require('supertest');
const { app, init, getPool } = require('../index');

const user = { name: 'Test User', email: 'test@example.com', password: 'secret123' };
const date = '2030-01-15';
let token, bus;

const book = (seats, t = token) =>
  request(app).post('/api/bookings').set('Authorization', `Bearer ${t}`).send({ busId: bus._id, date, seats });
const bookedSeats = async () =>
  (await request(app).get(`/api/buses/${bus._id}/seats?date=${date}`)).body.booked;

beforeAll(async () => {
  await init();
  const pool = getPool();
  await pool.query('DELETE FROM waitlist'); // child tables first (foreign keys)
  await pool.query('DELETE FROM booking_seats');
  await pool.query('DELETE FROM bookings');
  await pool.query("DELETE FROM buses WHERE operator = 'Test Bus'");
  await pool.query('DELETE FROM users');
  bus = (await request(app).get('/api/buses?from=Hyderabad&to=Bengaluru')).body[0];
});

afterAll(() => getPool().end());

describe('auth', () => {
  test('rejects a short password', async () => {
    const res = await request(app).post('/api/auth/register').send({ ...user, password: '123' });
    expect(res.status).toBe(400);
  });

  test('registers a new user and returns a JWT', async () => {
    const res = await request(app).post('/api/auth/register').send(user);
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
  });

  test('rejects a duplicate email', async () => {
    const res = await request(app).post('/api/auth/register').send(user);
    expect(res.status).toBe(409);
  });

  test('rejects a wrong password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password: 'wrong-pass' });
    expect(res.status).toBe(401);
  });

  test('logs in with correct credentials', async () => {
    const res = await request(app).post('/api/auth/login').send(user);
    expect(res.status).toBe(200);
    token = res.body.token;
    expect(token).toBeTruthy();
  });
});

describe('bus search', () => {
  test('finds buses for a route, cheapest first', async () => {
    const res = await request(app).get('/api/buses?from=hyderabad&to=bengaluru');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(1);
    const prices = res.body.map((b) => b.price);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  test('returns an empty list for an unknown route', async () => {
    const res = await request(app).get('/api/buses?from=Nowhere&to=Atlantis');
    expect(res.body).toEqual([]);
  });
});

describe('booking', () => {
  test('requires login', async () => {
    const res = await request(app).post('/api/bookings').send({ busId: bus._id, date, seats: [1] });
    expect(res.status).toBe(401);
  });

  test('rejects seat numbers outside the bus', async () => {
    expect((await book([999])).status).toBe(400);
    expect((await book([])).status).toBe(400);
  });

  test('books seats and marks them as taken', async () => {
    const res = await book([1, 2]);
    expect(res.status).toBe(201);
    expect(await bookedSeats()).toEqual(expect.arrayContaining([1, 2]));
  });

  test('blocks double-booking and books nothing from a failed request', async () => {
    const res = await book([2, 3]); // seat 2 is already taken
    expect(res.status).toBe(409);
    expect(await bookedSeats()).not.toContain(3); // transaction rolled back
  });

  test('lists my bookings with the correct total', async () => {
    const res = await request(app).get('/api/bookings').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].seats).toEqual([1, 2]);
    expect(res.body[0].total).toBe(bus.price * 2);
  });
});

describe('connecting routes', () => {
  test('requires from, to and a valid date', async () => {
    const res = await request(app).get('/api/connections?from=Hyderabad&to=Chennai');
    expect(res.status).toBe(400);
  });

  test('finds valid one-transfer itineraries', async () => {
    const res = await request(app).get('/api/connections?from=Hyderabad&to=Chennai&date=2030-01-15');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const t of res.body) {
      expect(t.legs[0].bus.to).toBe(t.legs[1].bus.from); // the legs really connect
      expect(t.layoverMinutes).toBeGreaterThanOrEqual(60);
      expect(t.layoverMinutes).toBeLessThanOrEqual(480);
    }
    const times = res.body.map((t) => t.totalMinutes);
    expect(times).toEqual([...times].sort((a, b) => a - b)); // fastest first
  });
});

describe('seat suggestions, cancellation and waitlist', () => {
  let tiny, tokenB, bookingA;
  const as = (t) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    await getPool().query("INSERT INTO buses (operator, type, from_city, to_city, departs, arrives, price, total_seats) VALUES ('Test Bus', 'AC', 'TestA', 'TestB', '10:00', '12:00', 100, 2)");
    tiny = (await request(app).get('/api/buses?from=TestA&to=TestB')).body[0];
    tokenB = (await request(app).post('/api/auth/register').send({ name: 'Second', email: 'second@example.com', password: 'secret123' })).body.token;
  });

  test('suggests free seats together, skipping booked ones', async () => {
    const res = await request(app).get(`/api/buses/${bus._id}/suggest?date=${date}&count=2`); // seats 1,2 are booked above
    expect(res.body.seats).toEqual([3, 4]);
  });

  test('a user cannot cancel someone else\'s booking', async () => {
    const r = await request(app).post('/api/bookings').set(as(token)).send({ busId: tiny._id, date, seats: [1, 2] });
    expect(r.status).toBe(201);
    bookingA = r.body._id;
    expect((await request(app).delete(`/api/bookings/${bookingA}`).set(as(tokenB))).status).toBe(404);
  });

  test('joins the waitlist when the bus is full', async () => {
    const res = await request(app).post('/api/waitlist').set(as(tokenB)).send({ busId: tiny._id, date, count: 2 });
    expect(res.status).toBe(201);
    expect(res.body.position).toBe(1);
  });

  test('cancelling frees the seats and books the first person in line', async () => {
    const res = await request(app).delete(`/api/bookings/${bookingA}`).set(as(token));
    expect(res.status).toBe(200);
    expect(res.body.promoted).toHaveLength(1);
    const mine = (await request(app).get('/api/bookings').set(as(tokenB))).body;
    expect(mine[0].seats).toEqual([1, 2]);
    expect((await request(app).get('/api/waitlist').set(as(tokenB))).body[0].status).toBe('confirmed');
  });
});
