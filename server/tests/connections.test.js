// Pure unit tests for the connecting-route logic: no database needed.
const { plan } = require('../index');

const bus = (departs, arrives, price = 500, to = 'Bengaluru', from = 'Hyderabad') =>
  ({ from, to, departs, arrives, price });

describe('plan()', () => {
  test('overnight first leg: second leg runs the next day', () => {
    const t = plan(bus('21:30', '06:00', 1100), bus('08:30', '14:00', 500, 'Chennai', 'Bengaluru'), '2030-01-15');
    expect(t.layoverMinutes).toBe(150);
    expect(t.legs[1].date).toBe('2030-01-16');
    expect(t.totalMinutes).toBe(510 + 150 + 330);
    expect(t.totalPrice).toBe(1600);
  });

  test('same-day connection keeps both legs on the same date', () => {
    const t = plan(bus('08:00', '12:00'), bus('14:00', '18:00', 400, 'Chennai', 'Bengaluru'), '2030-01-15');
    expect(t.layoverMinutes).toBe(120);
    expect(t.legs[1].date).toBe('2030-01-15');
  });

  test('rejects a tight connection (next departure would be a day later)', () => {
    // arrives 07:30, next bus leaves 08:00: only 30 min, below the 60 min minimum
    expect(plan(bus('20:00', '07:30'), bus('08:00', '12:00', 400, 'Chennai', 'Bengaluru'), '2030-01-15')).toBeNull();
  });

  test('rejects a layover longer than 8 hours', () => {
    expect(plan(bus('08:00', '12:00'), bus('21:00', '23:00', 400, 'Chennai', 'Bengaluru'), '2030-01-15')).toBeNull();
  });
});
