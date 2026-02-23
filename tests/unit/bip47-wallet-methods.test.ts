import assert from 'assert';

// Mock PaynymDirectory (used by abstract-hd-electrum-wallet.ts and hd-segwit-bech32-wallet.ts)
const mockNym = jest.fn();
jest.mock('../../blue_modules/paynym/PaynymDirectory', () => ({
  PaynymDirectory: {
    nym: mockNym,
  },
  __esModule: true,
  default: {
    nym: mockNym,
  },
}));

// Mock PaynymDisplayUtils (imported by hd-segwit-bech32-wallet.ts)
jest.mock('../../blue_modules/paynym/PaynymDisplayUtils', () => ({
  __esModule: true,
  default: {
    formatPaymentCode: (code: string) => code.substring(0, 12) + '...',
    isValidPaymentCode: () => true,
    getAvatarUrl: () => null,
  },
  PaynymDisplayUtils: {
    formatPaymentCode: (code: string) => code.substring(0, 12) + '...',
    isValidPaymentCode: () => true,
    getAvatarUrl: () => null,
  },
}));

import { HDSegwitBech32Wallet } from '../../class';

// Known valid BIP47 payment codes from test vectors
const BOB_PC = 'PM8TJS2JxQ5ztXUpBBRnpTbcUXbUHy2T1abfrb3KkAAtMEGNbey4oumH7Hc578WgQJhPjBxteQ5GHHToTYHE3A1w6p7tU6KSoFmWBVbFGjKPisZDbP97';
const ALICE_PC = 'PM8TJXuZNUtSibuXKFM6bhCxpNaSye6r4px2GXRV5v86uRdH9Raa8ZtXEkG7S4zLREf4ierjMsxLXSFTbRVUnRmvjw9qnc7zZbyXyBstSmjcb7uVcDYF';
const CHARLIE_PC = 'PM8TJi1RuCrgSHTzGMoayUf8xUW6zYBGXBPSWwTiMhMMwqto7G6NA4z9pN5Kn8Pbhryo2eaHMFRRcidCGdB3VCDXJD4DdPD2ZyG3ScLMEvtStAetvPMo';

const TEST_MNEMONIC = 'reward upper indicate eight swift arch injury crystal super wrestle already dentist';

describe('BIP47 wallet methods', () => {
  beforeEach(() => {
    mockNym.mockClear();
  });

  describe('addBIP47Receiver — bidirectional support', () => {
    it('skips adding to send list when code already in receive list', () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);

      // Simulate someone sent us a notification tx — their code is in receive list
      w._receive_payment_codes = [ALICE_PC];

      // Try to add to send list — should be skipped (receive list takes priority)
      w.addBIP47Receiver(ALICE_PC);

      assert.ok(w._receive_payment_codes.includes(ALICE_PC), 'Should remain in receive list');
      assert.strictEqual(w._send_payment_codes.length, 0, 'Should NOT be added to send list (receive wins)');
    });

    it('prevents duplicates within send list', () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);

      w.addBIP47Receiver(ALICE_PC);
      w.addBIP47Receiver(ALICE_PC);

      assert.strictEqual(w._send_payment_codes.length, 1);
    });

    it('adds new code to empty send list', () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);

      assert.strictEqual(w._send_payment_codes.length, 0);
      w.addBIP47Receiver(BOB_PC);
      assert.strictEqual(w._send_payment_codes.length, 1);
      assert.strictEqual(w._send_payment_codes[0], BOB_PC);
    });

    it('allows multiple different codes in send list', () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);

      w.addBIP47Receiver(ALICE_PC);
      w.addBIP47Receiver(BOB_PC);
      w.addBIP47Receiver(CHARLIE_PC);

      assert.strictEqual(w._send_payment_codes.length, 3);
    });
  });

  describe('fetchBIP47ReceiverPaymentCodesViaPaynym', () => {
    it('uses canonical (first) payment code from a nym profile', async () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);
      w.switchBIP47(true);

      const myPC = w.getBIP47PaymentCode();

      mockNym.mockImplementation(async (codeOrId: string) => {
        if (codeOrId === myPC) {
          // My own profile — following Alice, and I'm claimed
          return {
            value: {
              nymID: 'my_nym',
              following: [{ nymId: 'alice_nym' }],
              codes: [{ code: myPC, claimed: true }],
            },
            statusCode: 200,
            message: 'OK',
          };
        }
        if (codeOrId === 'alice_nym') {
          // Alice has TWO codes — codes[0] is canonical (segwit)
          return {
            value: {
              nymID: 'alice_nym',
              codes: [
                { code: ALICE_PC, claimed: true },
                { code: CHARLIE_PC, claimed: false },
              ],
            },
            statusCode: 200,
            message: 'OK',
          };
        }
        return { value: null, statusCode: 404, message: 'Not found' };
      });

      await w.fetchBIP47ReceiverPaymentCodesViaPaynym();

      // _resolveNymId returns codes[0] — the canonical/segwit code
      assert.ok(w._send_payment_codes.includes(ALICE_PC), 'Should include the canonical (first) code');
      assert.ok(!w._send_payment_codes.includes(CHARLIE_PC), 'Should NOT include the non-canonical code');
      assert.strictEqual(w._send_payment_codes.length, 1);
    });

    it('falls back to first code if none are claimed', async () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);
      w.switchBIP47(true);

      const myPC = w.getBIP47PaymentCode();

      mockNym.mockImplementation(async (codeOrId: string) => {
        if (codeOrId === myPC) {
          return {
            value: {
              nymID: 'my_nym',
              following: [{ nymId: 'bob_nym' }],
              codes: [{ code: myPC, claimed: true }],
            },
            statusCode: 200,
            message: 'OK',
          };
        }
        if (codeOrId === 'bob_nym') {
          // No claimed codes — should fall back to first
          return {
            value: {
              nymID: 'bob_nym',
              codes: [
                { code: CHARLIE_PC, claimed: false },
                { code: ALICE_PC, claimed: false },
              ],
            },
            statusCode: 200,
            message: 'OK',
          };
        }
        return { value: null, statusCode: 404, message: 'Not found' };
      });

      await w.fetchBIP47ReceiverPaymentCodesViaPaynym();

      assert.ok(w._send_payment_codes.includes(CHARLIE_PC), 'Should fall back to first code');
      assert.strictEqual(w._send_payment_codes.length, 1);
    });

    it('skips API recovery when paynym is unclaimed', async () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);
      w.switchBIP47(true);

      const myPC = w.getBIP47PaymentCode();

      mockNym.mockImplementation(async (codeOrId: string) => {
        if (codeOrId === myPC) {
          // Unclaimed paynym — following list is meaningless
          return {
            value: {
              nymID: 'my_nym',
              following: [{ nymId: 'alice_nym' }],
              codes: [{ code: myPC, claimed: false }],
            },
            statusCode: 200,
            message: 'OK',
          };
        }
        // Should never reach here — unclaimed should bail early
        return { value: null, statusCode: 404, message: 'Not found' };
      });

      await w.fetchBIP47ReceiverPaymentCodesViaPaynym();

      // Unclaimed paynym — should not attempt to recover contacts via API
      assert.strictEqual(w._send_payment_codes.length, 0, 'Should not recover contacts when unclaimed');
      // Only 1 call (own profile) — should not have fetched alice_nym
      assert.strictEqual(mockNym.mock.calls.length, 1, 'Should only call nym() once for own profile');
    });

    it('handles undefined following without crashing', async () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);
      w.switchBIP47(true);

      const myPC = w.getBIP47PaymentCode();

      mockNym.mockResolvedValue({
        value: {
          nymID: 'my_nym',
          // following is undefined (API returned partial data)
          codes: [{ code: myPC, claimed: true }],
        },
        statusCode: 200,
        message: 'OK',
      });

      // Should not throw
      await w.fetchBIP47ReceiverPaymentCodesViaPaynym();
      assert.strictEqual(w._send_payment_codes.length, 0);
    });

    it('handles empty following array', async () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);
      w.switchBIP47(true);

      const myPC = w.getBIP47PaymentCode();

      mockNym.mockResolvedValue({
        value: {
          nymID: 'my_nym',
          following: [],
          codes: [{ code: myPC, claimed: true }],
        },
        statusCode: 200,
        message: 'OK',
      });

      await w.fetchBIP47ReceiverPaymentCodesViaPaynym();
      assert.strictEqual(w._send_payment_codes.length, 0);
    });

    it('skips codes already in send list', async () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);
      w.switchBIP47(true);

      const myPC = w.getBIP47PaymentCode();

      // Pre-populate: Alice already in send list
      w._send_payment_codes = [ALICE_PC];

      mockNym.mockImplementation(async (codeOrId: string) => {
        if (codeOrId === myPC) {
          return {
            value: {
              nymID: 'my_nym',
              following: [{ nymId: 'alice_nym' }],
              codes: [{ code: myPC, claimed: true }],
            },
            statusCode: 200,
            message: 'OK',
          };
        }
        if (codeOrId === 'alice_nym') {
          return {
            value: {
              nymID: 'alice_nym',
              codes: [{ code: ALICE_PC, claimed: true }],
            },
            statusCode: 200,
            message: 'OK',
          };
        }
        return { value: null, statusCode: 404, message: 'Not found' };
      });

      await w.fetchBIP47ReceiverPaymentCodesViaPaynym();

      // Should not duplicate
      assert.strictEqual(w._send_payment_codes.length, 1);
      assert.strictEqual(w._send_payment_codes[0], ALICE_PC);
    });

    it('does nothing when BIP47 is disabled', async () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);
      // BIP47 NOT enabled (default)

      await w.fetchBIP47ReceiverPaymentCodesViaPaynym();

      assert.strictEqual(mockNym.mock.calls.length, 0, 'Should not call PaynymDirectory');
      assert.strictEqual(w._send_payment_codes.length, 0);
    });

    it('handles nym API returning non-200 gracefully', async () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);
      w.switchBIP47(true);

      mockNym.mockResolvedValue({
        value: null,
        statusCode: 404,
        message: 'Not found',
      });

      // Should not throw — the method has a try/catch
      await w.fetchBIP47ReceiverPaymentCodesViaPaynym();
      assert.strictEqual(w._send_payment_codes.length, 0);
    });

    it('batches requests when following many contacts', async () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);
      w.switchBIP47(true);

      const myPC = w.getBIP47PaymentCode();

      // Create 12 follows to test batching (should be 3 batches of 5,5,2)
      const follows = Array.from({ length: 12 }, (_, i) => ({ nymId: `nym_${i}` }));

      // Track call order to verify batching behavior
      const callOrder: string[] = [];

      mockNym.mockImplementation(async (codeOrId: string) => {
        if (codeOrId === myPC) {
          return {
            value: { nymID: 'my_nym', following: follows, codes: [{ code: myPC, claimed: true }] },
            statusCode: 200,
            message: 'OK',
          };
        }
        callOrder.push(codeOrId);
        // Return empty codes — we just care about batching, not results
        return {
          value: { nymID: codeOrId, codes: [] },
          statusCode: 200,
          message: 'OK',
        };
      });

      await w.fetchBIP47ReceiverPaymentCodesViaPaynym();

      // 1 call for own profile + 12 calls for follows = 13 total
      assert.strictEqual(mockNym.mock.calls.length, 13);
      // All 12 follows were processed
      assert.strictEqual(callOrder.length, 12);
    });
  });

  describe('isMyPaynymClaimed', () => {
    it('returns true when nym has a claimed code', async () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);
      w.switchBIP47(true);

      const myPC = w.getBIP47PaymentCode();

      mockNym.mockResolvedValue({
        value: {
          nymID: 'my_nym',
          codes: [{ code: myPC, claimed: true }],
          following: [],
          followers: [],
        },
        statusCode: 200,
        message: 'OK',
      });

      const result = await w.isMyPaynymClaimed();
      assert.strictEqual(result, true);
    });

    it('returns false when nym exists but no codes are claimed', async () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);
      w.switchBIP47(true);

      const myPC = w.getBIP47PaymentCode();

      mockNym.mockResolvedValue({
        value: {
          nymID: 'my_nym',
          codes: [{ code: myPC, claimed: false }],
          following: [],
          followers: [],
        },
        statusCode: 200,
        message: 'OK',
      });

      const result = await w.isMyPaynymClaimed();
      assert.strictEqual(result, false);
    });

    it('returns false when nym is not found (404)', async () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);
      w.switchBIP47(true);

      mockNym.mockResolvedValue({
        value: null,
        statusCode: 404,
        message: 'Not found',
      });

      const result = await w.isMyPaynymClaimed();
      assert.strictEqual(result, false);
    });

    it('returns false when BIP47 is disabled', async () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);
      // BIP47 NOT enabled

      const result = await w.isMyPaynymClaimed();
      assert.strictEqual(result, false);
      assert.strictEqual(mockNym.mock.calls.length, 0);
    });

    it('returns false when API throws', async () => {
      const w = new HDSegwitBech32Wallet();
      w.setSecret(TEST_MNEMONIC);
      w.switchBIP47(true);

      mockNym.mockRejectedValue(new Error('Network error'));

      const result = await w.isMyPaynymClaimed();
      assert.strictEqual(result, false);
    });
  });
});
