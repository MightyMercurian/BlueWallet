import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  Linking,
  Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import Clipboard from '@react-native-clipboard/clipboard';
import PaynymAvatar from '../../components/paynym/PaynymAvatar';
import { HDSegwitBech32Wallet } from '../../class';
import PaynymDirectory from '../../blue_modules/paynym/PaynymDirectory';
import { useTheme } from '../../components/themes';
import { useStorage } from '../../hooks/context/useStorage';

type RouteParams = {
  walletID: string;
};

const PaynymClaimScreen: React.FC = () => {
  const navigation = useNavigation();
  const route = useRoute<RouteProp<{ params: RouteParams }>>();
  const { walletID } = route.params;
  const { wallets } = useStorage();
  const wallet = wallets.find(w => w.getID() === walletID) as HDSegwitBech32Wallet | undefined;
  const { colors } = useTheme();

  const [loading, setLoading] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [paynymInfo, setPaynymInfo] = useState<any>(null);
  const [paymentCode, setPaymentCode] = useState('');

  if (!wallet) {
    return (
      <SafeAreaView style={styles.container}>
        <Text>Wallet not found</Text>
      </SafeAreaView>
    );
  }

  const stylesHook = StyleSheet.create({
    container: {
      backgroundColor: colors.elevated,
    },
    title: {
      color: colors.foregroundColor,
    },
    description: {
      color: colors.alternativeTextColor2,
    },
    nymName: {
      color: colors.foregroundColor,
    },
    paymentCode: {
      color: colors.alternativeTextColor2,
    },
    paymentCodeDisplay: {
      color: colors.alternativeTextColor2,
    },
    info: {
      color: colors.foregroundColor,
      backgroundColor: colors.inputBackgroundColor,
    },
    features: {
      backgroundColor: colors.inputBackgroundColor,
    },
    feature: {
      color: colors.foregroundColor,
    },
    linkText: {
      color: colors.foregroundColor,
    },
  });

  useEffect(() => {
    const initializeScreen = async () => {
      try {
        setLoading(true);
        const code = wallet.getBIP47PaymentCode();
        setPaymentCode(code);

        // Create/register Paynym on mount - this is the first step
        // If it already exists, the API returns the existing record (status 200)
        if (__DEV__) console.log('[INIT DEBUG] Calling create API...');
        const createResponse = await PaynymDirectory.create(code);
        if (__DEV__) {
          console.log('[INIT DEBUG] Create response status:', createResponse.statusCode);
          console.log('[INIT DEBUG] Create response message:', createResponse.message);
          console.log('[INIT DEBUG] Create response claimed:', createResponse.value?.claimed);
        }

        let paynymInfo: any = null;
        let isClaimed = false;

        if (createResponse.value) {
          // Extract info from create response
          paynymInfo = {
            code: code,
            nymName: createResponse.value.nymName,
            nymID: createResponse.value.nymID,
          };
          
          // For newly created (201), always show as unclaimed
          // For existing (200), trust the claimed field from response
          if (createResponse.statusCode === 201) {
            isClaimed = false; // Newly created is always unclaimed
            if (__DEV__) console.log('[INIT DEBUG] Status 201 - forcing isClaimed = false');
          } else {
            isClaimed = createResponse.value.claimed; // Trust API for existing
            if (__DEV__) console.log('[INIT DEBUG] Status 200 - using API claimed value:', isClaimed);
          }
        }

        if (__DEV__) {
          console.log('[INIT DEBUG] Final isClaimed state:', isClaimed);
          console.log('[INIT DEBUG] PaynymInfo:', paynymInfo);
        }

        setClaimed(isClaimed);
        setPaynymInfo(paynymInfo);

        setLoading(false);
      } catch (error) {
        console.error('Error initializing Paynym claim screen:', error);
        // On error, still show screen but with no info
        setLoading(false);
      }
    };

    initializeScreen();
  }, [walletID]);

  const handleClaim = useCallback(async () => {
    if (!wallet.allowBIP47()) {
      Alert.alert('Error', 'BIP47 is not supported by this wallet type');
      return;
    }

    setLoading(true);
    try {
      // Step 1: Get token for authentication
      const tokenResponse = await PaynymDirectory.token(paymentCode);
      if (!tokenResponse.value) {
        throw new Error(`Failed to get token: ${tokenResponse.message}`);
      }

      // Step 2: Generate signature with notification private key
      const signature = await wallet.generatePaynymClaimSignature(
        tokenResponse.value.token,
      );
      if (__DEV__) {
        console.log('[CLAIM DEBUG] Signature generated, length:', signature.length);
        console.log('[CLAIM DEBUG] Signature preview:', signature.substring(0, 20) + '...');
      }

      // Step 3: Claim ownership with signed token
      if (__DEV__) console.log('[CLAIM DEBUG] Calling claim API...');
      const claimResponse = await PaynymDirectory.claim(
        tokenResponse.value.token,
        signature,
      );
      if (__DEV__) {
        console.log('[CLAIM DEBUG] Claim response status:', claimResponse.statusCode);
        console.log('[CLAIM DEBUG] Claim response message:', claimResponse.message);
      }

      if (!claimResponse.value) {
        throw new Error(`Failed to claim: ${claimResponse.message}`);
      }

      // Step 4: Add payment code with segwit enabled
      // TODO: IMPLEMENTATION REQUIRED - Segwit payment code support
      //
      // Currently commented out because BlueWallet's BIP47 implementation generates
      // payment codes with the segwit bit set to 0x00 (non-segwit). The paynym API
      // returns segwit: false because it detects this bit is not flipped.
      //
      // To enable segwit payment codes:
      // 1. The payment code format has a segwit flag at byte index 1 (line 87 in node_modules/@spsina/bip47/src/bip47.js)
      // 2. This byte should be set to 0x01 instead of 0x00 to indicate segwit support
      // 3. Reference: BIP47 specification - byte 1 is reserved and should be 0x01 for segwit
      //
      // Implementation options:
      // Option A: Fork @spsina/bip47 library and modify getBinaryPaymentCode() to accept segwit parameter
      // Option B: Manually modify the payment code buffer after generation (flip byte at position 1 in binary payment code)
      //
      // Testing when implemented:
      // 1. Generate payment code with segwit bit set to 0x01
      // 2. Uncomment the code below
      // 3. Call /api/v1/nym/add with the payment code
      // 4. Verify API response returns segwit: true
      // 5. Store segwit flag locally using wallet.setPaymentCodeSegwit()
      //
      // Related files:
      // - node_modules/@spsina/bip47/src/bip47.js (line 87: paymentCodeSerializedBuffer[1] = 0x00;)
      // - class/wallets/abstract-hd-electrum-wallet.ts (segwit storage methods)
      // - blue_modules/paynym/PaynymDirectory.ts (add() method)
      //
      // Uncomment when segwit payment code support is available:
      /*
      console.log("[CLAIM DEBUG] Calling nym/add API for segwit...");
      const addTokenResponse = await PaynymDirectory.token(paymentCode);
      if (addTokenResponse.value) {
        const addSignature = await wallet.generatePaynymClaimSignature(
          addTokenResponse.value.token,
        );
        const nymIdentifier = paynymInfo?.nymID || paymentCode;
        const addResponse = await PaynymDirectory.add(
          addTokenResponse.value.token,
          addSignature,
          nymIdentifier,
          paymentCode,
          true,
        );
        console.log(
          "[CLAIM DEBUG] Add response status:",
          addResponse.statusCode,
        );
        console.log(
          "[CLAIM DEBUG] Add response segwit:",
          addResponse.value?.segwit,
        );
        // Store segwit status locally (like Samourai does)
        if (addResponse.value?.segwit && wallet.setPaymentCodeSegwit) {
          wallet.setPaymentCodeSegwit(paymentCode, true);
          console.log(
            "[CLAIM DEBUG] Stored segwit=true for payment code:",
            paymentCode.substring(0, 10) + "...",
          );
        }
      }
      */

      setClaimed(true);

      // Refresh info from directory
      const refreshedInfo = await wallet.getMyPaynymInfo(true);
      setPaynymInfo(refreshedInfo);

      Alert.alert(
        'Success!',
        `Your Paynym ${refreshedInfo?.nymName || ''} has been claimed!`,
        [{ text: 'OK' }],
      );
    } catch (error) {
      console.error('Error claiming Paynym:', error);
      Alert.alert(
        'Error',
        `Failed to claim Paynym: ${error instanceof Error ? error.message : String(error)}`,
        [{ text: 'OK' }],
      );
    } finally {
      setLoading(false);
    }
  }, [wallet, paymentCode]);

  const renderClaimed = () => (
    <View style={styles.content}>
      <Text style={[styles.title, stylesHook.title]}>
        Your PayNym is Claimed!
      </Text>

      {paynymInfo && (
        <View style={styles.paynymInfo}>
          <PaynymAvatar
            paymentCode={paymentCode}
            size={128}
            style={styles.avatar}
          />
          <Text style={[styles.nymName, stylesHook.nymName]}>
            {paynymInfo.nymName || paynymInfo.nymID}
          </Text>
          <TouchableOpacity onPress={() => Clipboard.setString(paymentCode)}>
            <Text style={[styles.paymentCode, stylesHook.paymentCode]}>
              {paymentCode}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <Text style={[styles.description, stylesHook.description]}>
        Your PayNym is ready to use! You can now:
      </Text>

      <View style={[styles.features, stylesHook.features]}>
        <Text style={[styles.feature, stylesHook.feature]}>
          • Share your +nymname with others
        </Text>
        <Text style={[styles.feature, stylesHook.feature]}>
          • Connect with other PayNyms
        </Text>
        <Text style={[styles.feature, stylesHook.feature]}>
          • Receive private payments
        </Text>
        <Pressable onPress={() => Linking.openURL('https://paynym.rs')}>
          <Text style={[styles.feature, stylesHook.feature]}>
            • Learn more at PayNym.rs
          </Text>
        </Pressable>
      </View>
    </View>
  );

  const renderUnclaimed = () => (
    <View style={styles.content}>
      <Text style={[styles.title, stylesHook.title]}>Claim Your PayNym</Text>

      <Text style={[styles.description, stylesHook.description]}>
        Your PayNym has been created with a unique robot avatar and name! Claim
        it to prove ownership and enable social features like following other
        PayNyms.
      </Text>

      <View style={styles.avatarContainer}>
        <PaynymAvatar paymentCode={paymentCode} size={96} />
      </View>

      {paynymInfo?.nymName && (
        <Text style={[styles.nymName, stylesHook.nymName]}>
          {paynymInfo.nymName}
        </Text>
      )}

      <Text style={[styles.paymentCodeDisplay, stylesHook.paymentCodeDisplay]}>
        {paymentCode.substring(0, 20)}...
      </Text>

      <Text style={[styles.info, stylesHook.info]}>
        ℹ️ Claiming your PayNym proves you own this payment code by signing with
        your private key. This is free and only requires registering your
        signature.
      </Text>

      <Text style={[styles.info, stylesHook.info]}>
        💡 You'll still need to send a small Bitcoin transaction later when you
        connect with another PayNym for the first time.
      </Text>

      <TouchableOpacity
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={handleClaim}
        disabled={loading || claimed}
      >
        {loading ? (
          <ActivityIndicator color='#fff' />
        ) : (
          <Text style={styles.buttonText}>Claim Ownership</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.linkButton}
        onPress={() => navigation.goBack()}
      >
        <Text style={[styles.linkText, stylesHook.linkText]}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );

  // Show a full-screen loader while we're registering the paynym on mount
  // (create() must succeed before the avatar exists on paynym.rs)
  if (loading && !paynymInfo) {
    return (
      <SafeAreaView style={[styles.container, stylesHook.container]}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.foregroundColor} />
          <Text style={[styles.loadingText, stylesHook.description]}>Loading your PayNym…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, stylesHook.container]}>
      <ScrollView style={styles.scrollView}>
        {claimed ? renderClaimed() : renderUnclaimed()}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 20,
    alignItems: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 30,
  },
  description: {
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
    marginBottom: 20,
  },
  avatarContainer: {
    marginBottom: 30,
    alignItems: 'center',
  },
  paynymInfo: {
    alignItems: 'center',
    marginBottom: 20,
  },
  avatar: {
    marginBottom: 15,
  },
  nymName: {
    fontSize: 20,
    fontWeight: '600',
    marginTop: 12,
  },
  paymentCode: {
    fontSize: 12,
    marginTop: 8,
    fontFamily: 'Courier',
  },
  paymentCodeDisplay: {
    fontSize: 14,
    fontFamily: 'Courier',
    marginBottom: 20,
  },
  info: {
    fontSize: 14,
    lineHeight: 20,
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
  },
  features: {
    alignSelf: 'stretch',
    padding: 20,
    borderRadius: 12,
    marginBottom: 20,
  },
  feature: {
    fontSize: 16,
    marginBottom: 8,
  },
  button: {
    backgroundColor: '#0c2074',
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 12,
    minWidth: 200,
  },
  buttonDisabled: {
    backgroundColor: '#9CA3AF',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  linkButton: {
    padding: 12,
    alignItems: 'center',
  },
  linkText: {
    fontSize: 16,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    fontSize: 16,
    textAlign: 'center',
  },
});

export default PaynymClaimScreen;
