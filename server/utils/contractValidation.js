// Contract field validation, shared so that creation, a direct edit and an
// approved amendment all enforce exactly the same rules.
//
// These two validators were originally private to routes/contractRoutes.js.
// They are now shared because the amendment workflow has to validate a PROPOSED
// contract as well: approving an amendment writes amount and the dates onto the
// contract, and a rule that only the direct-edit path knows about would let an
// approved amendment persist a negative amount or an end date before the start
// date, which is precisely the class of record the validators were added to
// prevent.
//
// COERCION
// --------
// The recurring defect on all three paths was a value that was SUPPOSED to be
// refused being silently turned into a real one, because the route reached for
// `new Date(x)` / `Number(x)` before checking what `x` actually was:
//
//   new Date(null)  -> 1970-01-01T00:00:00.000Z   (a perfectly valid Date)
//   Number('')      -> 0
//   Number(true)    -> 1
//   Number([])      -> 0
//   Number(['1000'])-> 1000
//
// Each of those produced a persisted contract that no editor could correct,
// because a later save would be refused - and, worse, nothing reported it.
// So a value is coerced here only after its type has been checked, and the
// three entry points below are what the routes call.

// The currencies the create and edit forms offer, and the only ones the
// dashboard's `Intl.NumberFormat` call and the report grouping were written
// for. The schema used to default `currency` to 'USD' without constraining it,
// so any string was stored and later reached `Intl.NumberFormat`, which throws
// a RangeError on an unknown code and took the whole dashboard render down with
// it. The enum now lives on the model as well, so a value that somehow reaches
// a save is still refused by the schema.
const CONTRACT_CURRENCIES = ['USD', 'EUR', 'GBP', 'INR'];

// Returns an error message, or null when the value is an allowed currency.
//
// Only `undefined` means "not supplied". An explicit `null` or `''` is a
// malformed currency, not an omission: treating them as absent is what let a
// null reach a `.trim()` on the caller's side and throw a 500. The value is
// matched exactly, with no trimming, so what is stored is always the literal
// enum member the schema and the dashboard both expect.
const validateContractCurrency = (currency) => {
  if (currency === undefined) return null;
  if (typeof currency !== 'string' || !CONTRACT_CURRENCIES.includes(currency)) {
    return `Currency must be one of ${CONTRACT_CURRENCIES.join(', ')}`;
  }
  return null;
};

// Returns the Date, or an error message.
//
// Refuses `null`, `''`, booleans, arrays and objects BEFORE calling `new Date`,
// because those coerce to a real Date (the epoch) rather than to NaN and so
// pass the NaN check below. A string, a finite number and a Date are accepted:
// the date input sends "YYYY-MM-DD", which `new Date` reads as UTC midnight.
const parseContractDate = (value) => {
  const coercible =
    typeof value === 'string' ||
    typeof value === 'number' ||
    value instanceof Date;

  if (!coercible || (typeof value === 'number' && !Number.isFinite(value))) {
    return 'A valid start date and end date are required';
  }
  if (typeof value === 'string' && !value.trim()) {
    return 'A valid start date and end date are required';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'A valid start date and end date are required';
  }
  return parsed;
};

// Returns an error message, or null when the range is valid.
// Both arguments must already be Date objects.
const validateContractDates = (startDate, endDate) => {
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return 'A valid start date and end date are required';
  }
  if (endDate < startDate) {
    return 'The end date must be on or after the start date';
  }
  return null;
};

// Returns the parsed non-negative number, or an error message.
//
// A JSON boolean, array or object is refused outright. `Number(true)` is 1 and
// `Number([])` is 0, so accepting them let a non-numeric body write a real
// amount. A numeric STRING is still accepted: the amount input is a
// `<input type="number">`, so the form sends "250000", not 250000.
const validateContractAmount = (amount) => {
  const isNumber = typeof amount === 'number';
  const isNumericString =
    typeof amount === 'string' && amount.trim() !== '' && Number.isFinite(Number(amount));

  if (!isNumber && !isNumericString) {
    return 'Amount must be a non-negative number';
  }

  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 'Amount must be a non-negative number';
  }
  return parsed;
};

module.exports = {
  CONTRACT_CURRENCIES,
  validateContractCurrency,
  parseContractDate,
  validateContractDates,
  validateContractAmount
};