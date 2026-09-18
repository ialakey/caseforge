import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  REFERRAL_CODE_LENGTH,
  ReferralRejection,
  checkReferralBinding,
  checkReferralClaim,
  normaliseReferralCode,
  referralCodeFromBytes,
  referralCodeSchema,
  referralCommission,
} from './referral.ts';

test('a generated code is the fixed length and free of look-alike characters', () => {
  const code = referralCodeFromBytes(new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253]));
  assert.equal(code.length, REFERRAL_CODE_LENGTH);
  // O/0 and I/1/L are the pairs people transcribe wrong off a screen.
  assert.match(code, /^[A-HJ-KM-NP-Z2-9]+$/);
});

test('a code needs enough entropy to be generated at all', () => {
  assert.throws(() => referralCodeFromBytes(new Uint8Array([1, 2, 3])));
});

test('codes are matched case-insensitively', () => {
  assert.equal(normaliseReferralCode('  abc123  '), 'ABC123');
  assert.equal(referralCodeSchema.parse('my-code'), 'MY-CODE');
  assert.equal(referralCodeSchema.safeParse('no').success, false);
  assert.equal(referralCodeSchema.safeParse('-leading-hyphen').success, false);
  assert.equal(referralCodeSchema.safeParse('has space').success, false);
});

test('commission is a share of the amount, rounded down', () => {
  assert.equal(referralCommission(1_000_00, 500), 5_000);
  assert.equal(referralCommission(333, 100), 3);
  // A commission is never worth more than the sum it was charged on.
  assert.equal(referralCommission(1, 100), 0);
  assert.equal(referralCommission(0, 500), 0);
  assert.equal(referralCommission(1_000_00, 0), 0);
  assert.equal(referralCommission(-100, 500), 0);
});

test('a player cannot be recruited by their own code, or twice', () => {
  const base = {
    enabled: true,
    found: true,
    isSelf: false,
    alreadyBound: false,
    accountActive: false,
  };

  assert.deepEqual(checkReferralBinding(base), { ok: true });
  assert.deepEqual(checkReferralBinding({ ...base, isSelf: true }), {
    ok: false,
    reason: ReferralRejection.SELF,
  });
  assert.deepEqual(checkReferralBinding({ ...base, alreadyBound: true }), {
    ok: false,
    reason: ReferralRejection.ALREADY_BOUND,
  });
  assert.deepEqual(checkReferralBinding({ ...base, found: false }), {
    ok: false,
    reason: ReferralRejection.NOT_FOUND,
  });
  assert.deepEqual(checkReferralBinding({ ...base, enabled: false }), {
    ok: false,
    reason: ReferralRejection.DISABLED,
  });
});

test('an account that has already played is nobody new recruit', () => {
  // The binding arrives as its own call after the Steam round trip, so the
  // endpoint is open afterwards; activity is what closes it.
  assert.deepEqual(
    checkReferralBinding({
      enabled: true,
      found: true,
      isSelf: false,
      alreadyBound: false,
      accountActive: true,
    }),
    { ok: false, reason: ReferralRejection.ACCOUNT_ACTIVE },
  );
});

test('a payout needs something to pay and enough of it', () => {
  assert.deepEqual(checkReferralClaim(500_00, 100_00), { ok: true, amount: 500_00 });
  assert.deepEqual(checkReferralClaim(0, 100_00), {
    ok: false,
    reason: 'NOTHING',
    required: 100_00,
  });
  assert.deepEqual(checkReferralClaim(50_00, 100_00), {
    ok: false,
    reason: 'BELOW_MIN',
    required: 100_00,
  });
  // A floor of zero lets anything be claimed, which is what it is for.
  assert.deepEqual(checkReferralClaim(1, 0), { ok: true, amount: 1 });
});
