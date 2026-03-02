import React, { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { RouteProp, useRoute } from '@react-navigation/native';
import { Icon } from '@rneui/themed';
import { useTheme } from '../../components/themes';
import { useExtendedNavigation } from '../../hooks/useExtendedNavigation';
import { useStorage } from '../../hooks/context/useStorage';
import triggerHapticFeedback, { HapticFeedbackTypes } from '../../blue_modules/hapticFeedback';
import presentAlert from '../../components/Alert';
import SafeAreaScrollView from '../../components/SafeAreaScrollView';
import { BlueSpacing10, BlueSpacing20 } from '../../components/BlueSpacing';
import Button from '../../components/Button';
import { SecondButton } from '../../components/SecondButton';
import PaynymAvatar from '../../components/paynym/PaynymAvatar';
import { SuccessView } from '../send/success';
import loc from '../../loc';
import { DetailViewStackParamList } from '../../navigation/DetailViewStackParamList';
import { scanQrHelper } from '../../helpers/scan-qr';
import { fetch } from '../../util/fetch';
import { getDomain } from '../../models/blockExplorer';

const LOG_TAG = '[Auth47]';

type Auth47RouteProps = RouteProp<DetailViewStackParamList, 'Auth47'>;

/**
 * Auth47 Authentication Screen
 *
 * Implements the Auth47 protocol for PayNym-based authentication.
 * Auth47 QR format: auth47://<nonce>?c=<callbackUrl>&r=<resource>[&e=<expiry>]
 *
 * Spec: https://bip47-website-3.up.railway.app/docs#auth47-spec
 *
 * Flow:
 * 1. Scan Auth47 QR code (challenge)
 * 2. Reconstruct the challenge string (always uses r= format):
 *    - If r= is present: auth47://<nonce>?r=<resource>[&e=<expiry>]
 *    - If r= is missing: auth47://<nonce>?r=<callbackUrl>[&e=<expiry>] (callback used as resource)
 * 3. Show confirmation with target domain
 * 4. Sign the challenge with the notification address private key (P2PKH message sig)
 * 5. POST response JSON to callback URL:
 *    { auth47_response: "1.0", challenge, signature, nym: paymentCode, address: null }
 */
const Auth47Screen: React.FC = () => {
  const { colors } = useTheme();
  const navigation = useExtendedNavigation();
  const { wallets } = useStorage();
  const route = useRoute<Auth47RouteProps>();
  const { walletID } = route.params;

  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'signing' | 'sending' | 'success' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [authedDomain, setAuthedDomain] = useState('');

  const wallet = wallets.find(w => w.getID() === walletID) as any;
  const paymentCode = wallet?.getBIP47PaymentCode ? wallet.getBIP47PaymentCode() : undefined;

  const stylesHook = StyleSheet.create({
    root: {
      backgroundColor: colors.elevated,
    },
    statusText: {
      color: colors.foregroundColor,
    },
    labelText: {
      color: colors.alternativeTextColor,
    },
    successText: {
      color: colors.msSuccessBG,
    },
    errorText: {
      color: colors.failedColor,
    },
  });

  /**
   * Parse an Auth47 URI per the Auth47 spec (matching Ashigaru/Samourai implementation).
   *
   * Format: auth47://<nonce>?c=<callbackUrl>[&r=<resource>][&e=<expiry>]
   *
   * - nonce   = the URI host (between auth47:// and ?)
   * - c       = callback URL to POST the response to
   * - r       = resource identifier (optional, defaults to callback URL for challenge)
   * - e       = optional expiry
   *
   * The "challenge" that gets signed ALWAYS uses 'r=' format:
   *   - If r= is present: auth47://<nonce>?r=<resource>[&e=<expiry>]
   *   - If r= is missing: auth47://<nonce>?r=<callbackUrl>[&e=<expiry>] (callback used as resource)
   *
   * NOTE: We use manual string splitting (not new URL()) because the `c` param
   * value is often an unencoded https:// URL whose `://` would break standard
   * URL parsers — exactly the same approach Ashigaru/Sparrow uses (query.split("&")).
   */
  const parseAuth47URI = (
    uri: string,
  ): { nonce: string; callbackUrl: string; resource: string | null; expiry: string | null; challenge: string } | null => {
    try {
      const normalized = uri.trim();
      if (!normalized.toLowerCase().startsWith('auth47://')) {
        return null;
      }

      // Strip scheme: everything after auth47://
      const withoutScheme = normalized.slice('auth47://'.length);

      // Split nonce from query string on the first '?'
      const qIdx = withoutScheme.indexOf('?');
      if (qIdx === -1) return null;

      const nonce = withoutScheme.slice(0, qIdx);
      if (!nonce) return null;

      const rawQuery = withoutScheme.slice(qIdx + 1);

      // Manual split — same as Sparrow's query.split("&") — handles unencoded URLs in values
      const params: Record<string, string> = {};
      for (const pair of rawQuery.split('&')) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx < 0) continue;
        const key = pair.slice(0, eqIdx);
        const value = pair.slice(eqIdx + 1);
        params[key] = value;
      }

      // 'c' is the required callback URL
      const callbackUrl = params['c'];
      if (!callbackUrl) return null;

      // 'r' is the resource; track if it was explicitly provided
      const resource = params['r'] ?? null;

      // 'e' is optional expiry
      const expiry = params['e'] ?? null;

      // Reconstruct the challenge string that must be signed.
      // Following Ashigaru/Samourai implementation:
      // - Challenge ALWAYS uses 'r=' format
      // - If 'r' param is present, use it as the resource value
      // - If 'r' param is missing/empty, use callback URL as the resource value
      const resourceValue = resource || callbackUrl;
      let challenge = `auth47://${nonce}?r=${resourceValue}`;
      if (expiry) {
        challenge += `&e=${expiry}`;
      }

      return { nonce, callbackUrl, resource, expiry, challenge };
    } catch {
      return null;
    }
  };

  const handleAuth47 = useCallback(async () => {
    console.log(`${LOG_TAG} Starting Auth47 flow`);

    if (!wallet) {
      console.error(`${LOG_TAG} Wallet not found`);
      presentAlert({ title: loc.errors.error, message: loc.auth47.wallet_not_found });
      return;
    }
    console.log(`${LOG_TAG} Wallet found: ${wallet.getID()}`);

    if (!wallet.getBIP47PaymentCode || !wallet.generatePaynymClaimSignature) {
      console.error(`${LOG_TAG} Wallet does not support BIP47/PayNym`);
      presentAlert({ title: loc.errors.error, message: loc.auth47.not_supported });
      return;
    }

    try {
      setLoading(true);
      setStatus('idle');
      setStatusMessage('');
      setAuthedDomain('');

      // Step 1: Scan QR code
      console.log(`${LOG_TAG} Opening QR scanner...`);
      const scannedData = await scanQrHelper();

      if (!scannedData) {
        console.log(`${LOG_TAG} QR scan cancelled by user`);
        setLoading(false);
        return;
      }
      console.log(`${LOG_TAG} Raw scanned data: ${scannedData}`);

      // Step 2: Parse the Auth47 URI
      console.log(`${LOG_TAG} Parsing Auth47 URI...`);
      const parsed = parseAuth47URI(scannedData);

      if (!parsed) {
        console.error(`${LOG_TAG} Failed to parse Auth47 URI - invalid format`);
        triggerHapticFeedback(HapticFeedbackTypes.NotificationError);
        setStatus('error');
        setStatusMessage(loc.auth47.invalid_qr);
        presentAlert({ title: loc.errors.error, message: loc.auth47.invalid_qr });
        setLoading(false);
        return;
      }

      console.log(`${LOG_TAG} Parsed URI - nonce: ${parsed.nonce}, callbackUrl: ${parsed.callbackUrl}, resource: ${parsed.resource}, expiry: ${parsed.expiry}`);
      console.log(`${LOG_TAG} Challenge string: ${parsed.challenge}`);

      // Step 2b: Check expiry
      if (parsed.expiry && Date.now() / 1000 > Number(parsed.expiry)) {
        console.error(`${LOG_TAG} Challenge has expired`);
        triggerHapticFeedback(HapticFeedbackTypes.NotificationError);
        setStatus('error');
        setStatusMessage(loc.auth47.expired);
        setLoading(false);
        return;
      }

      const { challenge, callbackUrl } = parsed;
      const domain = getDomain(callbackUrl) || callbackUrl;
      setAuthedDomain(domain);

      // Step 3: Confirm with user before signing
      console.log(`${LOG_TAG} Asking user to confirm authentication with ${domain}`);
      try {
        await new Promise<void>((resolve, reject) => {
          presentAlert({
            title: loc.auth47.confirm_title,
            message: loc.formatString(loc.auth47.confirm_message, { domain }),
            buttons: [
              { text: loc._.cancel, onPress: () => reject(new Error('cancelled')), style: 'cancel' },
              { text: loc.auth47.confirm_authenticate, onPress: () => resolve(), style: 'default' },
            ],
            options: { cancelable: false },
          });
        });
      } catch {
        console.log(`${LOG_TAG} User cancelled authentication`);
        setLoading(false);
        setAuthedDomain('');
        return;
      }

      // Step 4: Sign the challenge
      setStatus('signing');
      setStatusMessage(loc.formatString(loc.auth47.signing, { domain }));
      console.log(`${LOG_TAG} Getting payment code...`);
      const pc = wallet.getBIP47PaymentCode();
      console.log(`${LOG_TAG} Payment code: ${pc}`);
      console.log(`${LOG_TAG} Generating signature for challenge...`);
      const signature = await wallet.generatePaynymClaimSignature(challenge);
      console.log(`${LOG_TAG} Signature generated: ${signature}`);

      // Step 5: POST the auth response to the callback URL
      // Response format per Auth47 spec:
      // { auth47_response: "1.0", challenge, signature, nym }
      // Note: 'address' field is omitted (not required by spec)
      setStatus('sending');
      setStatusMessage(loc.formatString(loc.auth47.sending, { domain }));

      const requestBody = {
        auth47_response: '1.0',
        challenge,
        signature,
        nym: pc,
      };
      console.log(`${LOG_TAG} POSTing to callback URL: ${callbackUrl}`);
      console.log(`${LOG_TAG} Request body: ${JSON.stringify(requestBody)}`);

      const response = await fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      console.log(`${LOG_TAG} Response status: ${response.status} ${response.statusText}`);

      if (response.ok) {
        console.log(`${LOG_TAG} Auth successful!`);
        triggerHapticFeedback(HapticFeedbackTypes.NotificationSuccess);
        setStatus('success');
        setStatusMessage(loc.auth47.success);
      } else {
        const responseText = await response.text().catch(() => response.statusText);
        console.error(`${LOG_TAG} Server error: ${response.status} - ${responseText}`);
        throw new Error(`${loc.auth47.server_error}: ${response.status} - ${responseText}`);
      }
    } catch (e: any) {
      console.error(`${LOG_TAG} Error in Auth47 flow:`, e);
      console.error(`${LOG_TAG} Error message: ${e?.message}`);
      console.error(`${LOG_TAG} Error stack: ${e?.stack}`);
      triggerHapticFeedback(HapticFeedbackTypes.NotificationError);
      setStatus('error');
      const errorMsg = e?.message || loc.auth47.unknown_error;
      setStatusMessage(errorMsg);
      if (!errorMsg.includes(loc.auth47.invalid_qr)) {
        presentAlert({ title: loc.errors.error, message: errorMsg });
      }
    } finally {
      setLoading(false);
      console.log(`${LOG_TAG} Auth47 flow completed`);
    }
  }, [wallet]);

  const handleReset = () => {
    setStatus('idle');
    setStatusMessage('');
    setAuthedDomain('');
  };

  const renderStatus = () => {
    if (status === 'success') {
      return (
        <View style={styles.statusContainer}>
          <SuccessView />
          <BlueSpacing20 />
          <Text style={[styles.statusTitle, stylesHook.successText]}>{loc.auth47.success_title}</Text>
          <BlueSpacing10 />
          <Text style={[styles.statusSubtitle, stylesHook.labelText]}>
            {loc.formatString(loc.auth47.success_subtitle, { domain: authedDomain })}
          </Text>
          <BlueSpacing20 />
          <SecondButton onPress={handleReset} title={loc.auth47.authenticate_again} />
          <BlueSpacing20 />
          <Button onPress={() => navigation.goBack()} title={loc._.ok} />
        </View>
      );
    }

    if (status === 'error') {
      return (
        <View style={styles.statusContainer}>
          <View style={[styles.errorIconContainer, { backgroundColor: colors.elevated }]}>
            <Icon name="times" size={50} type="font-awesome" color={colors.failedColor} />
          </View>
          <BlueSpacing20 />
          <Text style={[styles.statusTitle, stylesHook.errorText]}>{loc.auth47.error_title}</Text>
          <BlueSpacing10 />
          <Text style={[styles.statusSubtitle, stylesHook.labelText]}>{statusMessage}</Text>
          <BlueSpacing20 />
          <Button onPress={handleReset} title={loc.auth47.try_again} />
        </View>
      );
    }

    if (loading) {
      return (
        <View style={styles.statusContainer}>
          <ActivityIndicator size="large" color={colors.buttonBackgroundColor} />
          <BlueSpacing20 />
          <Text style={[styles.statusSubtitle, stylesHook.labelText]}>{statusMessage}</Text>
        </View>
      );
    }

    return null;
  };

  return (
    <SafeAreaScrollView style={[styles.root, stylesHook.root]} contentContainerStyle={styles.contentContainer}>
      <BlueSpacing20 />

      {paymentCode && status === 'idle' && !loading && (
        <View style={styles.avatarContainer}>
          <PaynymAvatar paymentCode={paymentCode} size={80} />
          <BlueSpacing20 />
        </View>
      )}

      <View style={styles.descriptionContainer}>
        <Text style={[styles.descriptionTitle, stylesHook.statusText]}>{loc.auth47.description_title}</Text>
        <Text style={[styles.descriptionText, stylesHook.labelText]}>{loc.auth47.description}</Text>
      </View>

      <BlueSpacing20 />

      {renderStatus()}

      {(status === 'idle' || status === 'error') && !loading && (
        <>
          <BlueSpacing20 />
          <View style={styles.buttonContainer}>
            <Button onPress={handleAuth47} title={loc.auth47.scan_button} testID="Auth47ScanButton" />
          </View>
        </>
      )}

      <BlueSpacing20 />
    </SafeAreaScrollView>
  );
};

export default Auth47Screen;

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  avatarContainer: {
    alignItems: 'center',
  },
  descriptionContainer: {
    marginBottom: 10,
  },
  descriptionTitle: {
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 8,
  },
  descriptionText: {
    fontSize: 14,
    lineHeight: 20,
  },
  statusContainer: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  errorIconContainer: {
    width: 120,
    height: 120,
    borderRadius: 60,
    alignSelf: 'center',
    justifyContent: 'center',
    alignItems: 'center',
  },
  statusTitle: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
  },
  statusSubtitle: {
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 20,
    lineHeight: 20,
  },
  buttonContainer: {
    paddingHorizontal: 0,
  },
});
