// Type declarations for global objects
declare const console: {
  log: (message?: any, ...optionalParams: any[]) => void;
  error: (message?: any, ...optionalParams: any[]) => void;
};

import { AbstractHDElectrumWallet } from './abstract-hd-electrum-wallet';
import { ECPairFactory } from 'ecpair';
import ecc from '../../blue_modules/noble_ecc';
import PaynymDirectory from '../../blue_modules/paynym/PaynymDirectory';
import PaynymDisplayUtils from '../../blue_modules/paynym/PaynymDisplayUtils';
import { PaynymInfo } from '../../blue_modules/paynym/PaynymDirectory';
import * as bitcoinMessage from 'bitcoinjs-message';

const ECPair = ECPairFactory(ecc);

/**
 * HD Wallet (BIP39).
 * In particular, BIP84 (Bech32 Native Segwit)
 * @see https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki
 */
export class HDSegwitBech32Wallet extends AbstractHDElectrumWallet {
  static readonly type = 'HDsegwitBech32';
  static readonly typeReadable = 'HD SegWit (BIP84 Bech32 Native)';
  // @ts-ignore: override
  public readonly type = HDSegwitBech32Wallet.type;
  // @ts-ignore: override
  public readonly typeReadable = HDSegwitBech32Wallet.typeReadable;
  public readonly segwitType = 'p2wpkh';
  static readonly derivationPath = "m/84'/0'/0'";

  allowSend() {
    return true;
  }

  allowRBF() {
    return true;
  }

  allowPayJoin() {
    return true;
  }

  allowCosignPsbt() {
    return true;
  }

  isSegwit() {
    return true;
  }

  allowSignVerifyMessage() {
    return true;
  }

  allowMasterFingerprint() {
    return true;
  }

  allowXpub() {
    return true;
  }

  allowBIP47() {
    return true;
  }

  allowSilentPaymentSend(): boolean {
    return true;
  }

  /**
   * Get Paynym information for this wallet's payment code
   * @param forceRefresh - Force refresh from directory
   * @returns Promise<PaynymInfo | null>
   */
  async getMyPaynymInfo(forceRefresh: boolean = false): Promise<PaynymInfo | null> {
    if (!this.allowBIP47() || !this.isBIP47Enabled()) {
      return null;
    }

    const paymentCode = this.getBIP47PaymentCode();
    if (!paymentCode) {
      return null;
    }

    return await PaynymDirectory.getPaynymInfoCached(paymentCode, forceRefresh);
  }

  /**
   * Get display name for this wallet
   * @returns Formatted display name
   */
  getMyPaynymDisplay(): string {
    if (!this.allowBIP47() || !this.isBIP47Enabled()) {
      return this.getBIP47PaymentCode() || 'Paynym disabled';
    }

    const paymentCode = this.getBIP47PaymentCode();
    if (!paymentCode) {
      return 'No payment code';
    }

    return PaynymDisplayUtils.formatPaymentCode(paymentCode);
  }

  /**
   * Check if Paynym is claimed (not just created) in the directory
   * @returns Promise<boolean>
   */
  async isMyPaynymClaimed(): Promise<boolean> {
    if (!this.allowBIP47() || !this.isBIP47Enabled()) return false;

    const paymentCode = this.getBIP47PaymentCode();
    if (!paymentCode) return false;

    try {
      const response = await PaynymDirectory.nym(paymentCode);
      if (!response.value || response.statusCode !== 200) return false;
      return response.value.codes.some(c => c.claimed);
    } catch {
      return false;
    }
  }

  /**
   * Claim this wallet's Paynym (register with directory)
   * Gets a fresh token, signs it, and submits the claim in one atomic flow.
   * @returns Promise<any>
   */
  async claimMyPaynym(): Promise<any> {
    if (!this.allowBIP47() || !this.isBIP47Enabled()) {
      throw new Error('BIP47 is not enabled for this wallet');
    }

    const paymentCode = this.getBIP47PaymentCode();
    if (!paymentCode) {
      throw new Error('No payment code available for claiming');
    }

    return await PaynymDirectory.claimPaynym(paymentCode, (token) => this.generatePaynymClaimSignature(token));
  }

  /**
   * Generate signature for Paynym claim or Auth47 challenge
   * Signs token/challenge string with BIP47 notification address private key
   * @param token - Token from paynym.rs API OR Auth47 challenge string
   * @returns Promise<string> Base64-encoded signature
   */
  async generatePaynymClaimSignature(token: string): Promise<string> {
    if (!this.allowBIP47() || !this.isBIP47Enabled()) {
      throw new Error('BIP47 is not enabled for this wallet');
    }

    const paymentCode = this.getBIP47PaymentCode();
    if (!paymentCode) {
      throw new Error('No payment code available');
    }

    const bip47Instance = this.getBIP47FromSeed();
    const notificationNode = bip47Instance.getNotificationNode();

    if (!notificationNode || !notificationNode.privateKey) {
      throw new Error('Failed to derive notification private key');
    }

    // Validate private key is on secp256k1 curve before signing
    ECPair.fromPrivateKey(notificationNode.privateKey);

    // Use Bitcoin message signing (like BitcoinJ's ECKey.signMessage())
    // This matches Samourai/Sparrow implementation

    // Sign the raw token string using Bitcoin message signing standard
    // bitcoinMessage.sign() will:
    // 1. Add magic bytes: "\x18Bitcoin Signed Message:\n" + length + message
    // 2. Double SHA256 hash the prefixed message
    // 3. Sign with recoverable ECDSA (65 bytes: recovery flag + r + s)
    // 4. Return Buffer that can be base64 encoded
    const signature = bitcoinMessage.sign(
      token, // Sign the raw token string, not bytes
      notificationNode.privateKey, // BIP47 notification private key
      true, // Use compressed public key format
    );

    // Convert signature to base64 string (NOT hex!)
    // Paynym API expects base64 format (like BitcoinJ's ECKey.signMessage())
    return signature.toString('base64');
  }

  /**
   * Get Paynym info for any payment code
   * @param paymentCode - BIP47 payment code
   * @param forceRefresh - Force refresh from directory
   * @returns Promise<PaynymInfo | null>
   */
  async getPaynymInfo(paymentCode: string, forceRefresh: boolean = false): Promise<PaynymInfo | null> { 
    if (!this.allowBIP47() || !this.isBIP47Enabled()) {
      return null;
    }

    if (!PaynymDisplayUtils.isValidPaymentCode(paymentCode)) {
      throw new Error('Invalid payment code format');
    }

    return await PaynymDirectory.getPaynymInfoCached(paymentCode, forceRefresh);
  }

  /**
   * Check if connected to a Paynym (BIP47 notification sent)
   * @param paymentCode - BIP47 payment code
   * @returns boolean
   */
  isConnectedToPaynym(paymentCode: string): boolean {
    const notificationTx = this.getBIP47NotificationTransaction(paymentCode);
    return !!notificationTx;
  }

  /**
   * Get following list for a Paynym
   * @param paymentCode - BIP47 payment code
   * @returns Promise<PaynymInfo[]>
   */
  async getPaynymFollowing(paymentCode: string): Promise<PaynymInfo[]> {
    if (!this.allowBIP47() || !this.isBIP47Enabled()) {
      return [];
    }

    return await PaynymDirectory.getFollowing(paymentCode);
  }

  /**
   * Get followers list for a Paynym
   * @param paymentCode - BIP47 payment code
   * @returns Promise<PaynymInfo[]>
   */
  async getPaynymFollowers(paymentCode: string): Promise<PaynymInfo[]> {
    if (!this.allowBIP47() || !this.isBIP47Enabled()) {
      return [];
    }

    return await PaynymDirectory.getFollowers(paymentCode);
  }

  /**
   * Get avatar URL for a payment code
   * @param paymentCode - BIP47 payment code
   * @returns Promise<string | null>
   */
  async getPaynymAvatar(paymentCode: string): Promise<string | null> {
    if (!paymentCode) {
      return null;
    }
    return PaynymDisplayUtils.getAvatarUrl(paymentCode);
  }

  /**
   * Get all payment codes with their Paynym display info
   * @param forceRefresh - Force refresh from directory
   * @returns Promise<Array<{paymentCode: string, paynymInfo: PaynymInfo | null, display: string}>>
   */
  async getConnectedPaynyms(forceRefresh: boolean = false): Promise< Array<{paymentCode: string; paynymInfo: PaynymInfo | null; display: string;}> > {
    if (!this.allowBIP47() || !this.isBIP47Enabled()) {
      return [];
    }

    const senderPaymentCodes = this.getBIP47SenderPaymentCodes();
    const receiverPaymentCodes = this.getBIP47ReceiverPaymentCodes();
    const allPaymentCodes = [...senderPaymentCodes, ...receiverPaymentCodes];

    const results = [];
    for (const paymentCode of allPaymentCodes) {
      try {
        const paynymInfo = paymentCode ? await PaynymDirectory.getPaynymInfoCached(paymentCode, forceRefresh) : null;
        const display = paynymInfo ? PaynymDisplayUtils.formatPaymentCode(paymentCode, paynymInfo) : PaynymDisplayUtils.formatPaymentCode(paymentCode);

        results.push({
          paymentCode,
          paynymInfo,
          display,
        });
      } catch (error) {
        console.error(`Error fetching Paynym info for ${paymentCode}:`, error);
        results.push({
          paymentCode,
          paynymInfo: null,
          display: PaynymDisplayUtils.formatPaymentCode(paymentCode),
        });
      }
    }

    return results;
  }

  /**
   * Search for Paynyms by name or payment code
   * @param query - Search query
   * @returns Promise<Array<{paymentCode: string, paynymInfo: PaynymInfo | null, display: string}>>
   */
  async searchPaynyms(query: string): Promise< Array<{paymentCode: string; paynymInfo: PaynymInfo | null; display: string;}> > {
    if (!this.allowBIP47() || !this.isBIP47Enabled()) {
      return [];
    }

    // For now, only search by exact payment code or cached Paynym names
    const senderPaymentCodes = this.getBIP47SenderPaymentCodes();
    const receiverPaymentCodes = this.getBIP47ReceiverPaymentCodes();
    const allPaymentCodes = [...senderPaymentCodes, ...receiverPaymentCodes];

    const results = [];
    const lowerQuery = query.toLowerCase();

    for (const paymentCode of allPaymentCodes) {
      try {
        const paynymInfo = paymentCode
          ? await PaynymDirectory.getPaynymInfoCached(paymentCode)
          : null;
        const display = paynymInfo
          ? PaynymDisplayUtils.formatPaymentCode(paymentCode, paynymInfo)
          : PaynymDisplayUtils.formatPaymentCode(paymentCode);

        // Check if payment code matches or if Paynym name matches
        if (
          paymentCode.toLowerCase().includes(lowerQuery) ||
          (paynymInfo?.nymName &&
            paynymInfo.nymName.toLowerCase().includes(lowerQuery))
        ) {
          results.push({
            paymentCode,
            paynymInfo,
            display,
          });
        }
      } catch (error) {
        console.error(`Error searching Paynym for ${paymentCode}:`, error);
      }
    }

    return results;
  }
}
