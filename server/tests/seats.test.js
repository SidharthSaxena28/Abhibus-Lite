// Pure unit tests for seat suggestions: no database needed.
const { suggestSeats } = require('../index');

describe('suggestSeats()', () => {
  test('gives the front seats together when the bus is empty', () => {
    expect(suggestSeats(24, [], 3)).toEqual([1, 2, 3]);
  });
  test('skips booked seats and keeps the group in one row', () => {
    expect(suggestSeats(24, [2], 2)).toEqual([3, 4]);
  });
  test('spans as few rows as possible for bigger groups', () => {
    expect(suggestSeats(24, [], 5)).toEqual([1, 2, 3, 4, 5]);
  });
  test('returns nothing when there are not enough seats or the count is invalid', () => {
    expect(suggestSeats(4, [1, 2], 3)).toEqual([]);
    expect(suggestSeats(24, [], 0)).toEqual([]);
  });
});
