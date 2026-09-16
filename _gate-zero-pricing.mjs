import assert from 'node:assert/strict';
import { letterPriceFor, resolveLetters } from './rooms-store.js';

const paidSeats = { passkeyTickPrice: '0.005', passkeyTickSeconds: 1 };

const freeMegaChats = resolveLetters({
  letters: { enabled: true, maxSeconds: 10, price: '0' },
});
assert.equal(freeMegaChats.price, '0', 'an explicit zero MegaChat price must survive normalization');
assert.equal(
  letterPriceFor({ ...paidSeats, letters: freeMegaChats }),
  '0',
  'MegaChats can be free while live camera seats remain paid',
);

const automaticMegaChats = resolveLetters({
  letters: { enabled: true, maxSeconds: 10, price: null },
});
assert.equal(
  letterPriceFor({ ...paidSeats, letters: automaticMegaChats }),
  '0.05',
  'an empty MegaChat price must still derive from the live-seat rate',
);

console.log('PASS zero pricing is explicit and independent');
