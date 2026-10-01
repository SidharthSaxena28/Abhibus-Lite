# Abhibus Lite

A small bus-booking prototype: search routes, pick seats, book, and view your trips.

**Stack:** React (hooks, props, Context API) · Node + Express REST API · MySQL (mysql2, plain SQL) · JWT auth · responsive CSS

## Run locally
```bash
# 1. API (needs MySQL running; defaults: root user, no password. Override with DB_HOST, DB_USER, DB_PASSWORD)
cd server && npm install && npm start      # http://localhost:5001, creates the database + tables and seeds sample buses

# 2. Web app
cd client && npm install && npm run dev    # http://localhost:5173
```
Try **Hyderabad → Bengaluru**, sign up, pick seats, then check **My trips**.

## REST API
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/auth/register, /api/auth/login | no | Returns `{ token, user }` |
| GET | /api/buses?from=&to= | no | Search buses |
| GET | /api/connections?from=&to=&date= | no | One-transfer itineraries with layover rules |
| GET | /api/buses/:id/suggest?date=&count= | no | Best free seats together |
| GET | /api/buses/:id/stream?date= | no | Live seat map (Server-Sent Events) |
| POST | /api/buses/:id/hold | no | Temporarily hold seats while choosing |
| DELETE | /api/bookings/:id | JWT | Cancel and auto-book the waitlist |
| POST, GET | /api/waitlist | JWT | Join / view the waitlist |
| GET | /api/buses/:id/seats?date= | no | Booked seat numbers |
| POST | /api/bookings | JWT | Book seats `{ busId, date, seats[] }` |
| GET | /api/bookings | JWT | Your bookings |

Test with Postman: log in, copy the token, send it as `Authorization: Bearer <token>`.

## Connecting routes
If no direct bus fits, the app finds one-transfer itineraries (for example Hyderabad to Chennai via Bengaluru). A transfer needs a layover of 1 to 8 hours, overnight arrivals roll the second leg to the next day, and results are sorted fastest first. You pick seats for each leg in turn.

## More features
- **Smart seat suggestions:** enter the number of travellers and get the best free seats together (fewest rows, tightest group, nearest the front).
- **Live shared seat map:** the seat map updates in real time (Server-Sent Events). Seats someone else is choosing show in orange for 2 minutes, and "Share live link" lets friends open the same bus and pick seats together.
- **Cancellation + waitlist:** if a bus is full, join the waitlist. When anyone cancels, the freed seats are given to the first people in line, in the same database transaction.

## Tests
Integration tests (Jest + Supertest) cover auth, search and the booking rules, including double-booking and rollback.
They use a separate `abhibus_lite_test` database, so your real data is untouched. MySQL must be running.
```bash
cd server && DB_PASSWORD="yourpassword" npm test
```

## Known limits (honest list)
- Seat holds and live viewers are kept in server memory, so they reset on restart and only work with a single server instance (production would use Redis).
- The waitlist skips a group that doesn't fit yet so the next person can be served, which is a fairness trade-off.
- The two legs of a transfer are booked one after the other, not atomically. If leg 2 fails, leg 1 stays booked.
- Transfers are limited to one stop, and schedules repeat daily.
- Seat double-booking is prevented by a UNIQUE key on (bus_id, travel_date, seat_no) plus a transaction.
- No payments or cancellations yet. Tests cover the API only; the React UI has none.
- Set `JWT_SECRET` and the `DB_*` env vars when deploying (e.g. Render + a hosted MySQL).
