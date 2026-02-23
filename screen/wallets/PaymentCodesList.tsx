import React, { useEffect, useMemo, useState } from 'react';
import Clipboard from '@react-native-clipboard/clipboard';
import { RouteProp, StackActions, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import assert from 'assert';
import { sha256 } from '@noble/hashes/sha256';
import { SectionList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as BlueElectrum from '../../blue_modules/BlueElectrum';
import { satoshiToLocalCurrency } from '../../blue_modules/currency';
import { HDSegwitBech32Wallet } from '../../class';
import { ContactList } from '../../class/contact-list';
import { AbstractHDElectrumWallet } from '../../class/wallets/abstract-hd-electrum-wallet';
import presentAlert from '../../components/Alert';
import Button from '../../components/Button';
import { useTheme } from '../../components/themes';
import ToolTipMenu from '../../components/TooltipMenu';
import { Action } from '../../components/types';
import confirm from '../../helpers/confirm';
import prompt from '../../helpers/prompt';
import loc, { formatBalance } from '../../loc';
import { BitcoinUnit } from '../../models/bitcoinUnits';
import SafeArea from '../../components/SafeArea';
import { useExtendedNavigation } from '../../hooks/useExtendedNavigation';
import { useStorage } from '../../hooks/context/useStorage';
import { DetailViewStackParamList } from '../../navigation/DetailViewStackParamList';
import { BlueLoading } from '../../components/BlueLoading';
import { uint8ArrayToHex } from '../../blue_modules/uint8array-extras';
import PaynymAvatar from '../../components/paynym/PaynymAvatar';
import PaynymDirectory from '../../blue_modules/paynym/PaynymDirectory';

interface DataSection {
  title: string;
  data: string[];
}

enum Actions {
  pay,
  rename,
  copyToClipboard,
  hide,
}

const actionKeys: Action[] = [
  {
    id: Actions.pay,
    text: loc.bip47.pay_this_contact,
    icon: {
      iconValue: 'paperplane',
    },
  },
  {
    id: Actions.rename,
    text: loc.bip47.rename_contact,
    icon: {
      iconValue: 'pencil',
    },
  },
  {
    id: Actions.copyToClipboard,
    text: loc.bip47.copy_payment_code,
    icon: {
      iconValue: 'doc.on.doc',
    },
  },
  {
    id: Actions.hide,
    text: loc.bip47.hide_contact,
    icon: {
      iconValue: 'eye.slash',
    },
  },
];

function onlyUnique(value: any, index: number, self: any[]) {
  return self.indexOf(value) === index;
}

type PaymentCodeListRouteProp = RouteProp<DetailViewStackParamList, 'PaymentCodeList'>;
type PaymentCodesListNavigationProp = NativeStackNavigationProp<DetailViewStackParamList, 'PaymentCodeList'>;

export default function PaymentCodesList() {
  const navigation = useExtendedNavigation<PaymentCodesListNavigationProp>();
  const route = useRoute<PaymentCodeListRouteProp>();
  const { walletID } = route.params;
  const { wallets, txMetadata, counterpartyMetadata, saveToDisk } = useStorage();
  const [reload, setReload] = useState<number>(0);
  const [data, setData] = useState<DataSection[]>([]);
  const { colors } = useTheme();
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadingText, setLoadingText] = useState<string>('Loading...');
  const [paynymInfoCache, setPaynymInfoCache] = useState<Record<string, { nymName: string; claimed: boolean }>>({});
  const state = navigation.getState();
  const previousRouteIndex = state.index - 1;

  let previousRouteName: string | null;
  if (previousRouteIndex >= 0) {
    previousRouteName = state.routes[previousRouteIndex].name;
  }

  useEffect(() => {
    if (!walletID) return;

    const foundWallet = wallets.find(w => w.getID() === walletID) as unknown as AbstractHDElectrumWallet;
    if (!foundWallet) return;

    const newData: DataSection[] = [
      {
        title: '',
        data: foundWallet.getAllBIP47PaymentCodes(),
      },
    ];
    setData(newData);
  }, [walletID, wallets, reload]);

  // Fetch Paynym info for all payment codes on mount
  useEffect(() => {
    const fetchPaynymInfo = async () => {
      if (!walletID) return;

      const foundWallet = wallets.find(w => w.getID() === walletID) as unknown as AbstractHDElectrumWallet;
      if (!foundWallet) return;

      const paymentCodes = foundWallet.getBIP47SenderPaymentCodes()
        .concat(foundWallet.getBIP47ReceiverPaymentCodes())
        .filter(onlyUnique);

      const newCache: Record<string, { nymName: string; claimed: boolean }> = {};

      for (const pc of paymentCodes) {
        try {
          // Use cached version if available
          const paynymInfo = await PaynymDirectory.getPaynymInfoCached(pc);
          if (paynymInfo && paynymInfo.nymName) {
            // Check if claimed by calling nym API directly
            const nymResponse = await PaynymDirectory.nym(pc);
            if (nymResponse.value && nymResponse.value.codes?.[0]?.claimed) {
              newCache[pc] = {
                nymName: nymResponse.value.nymName,
                claimed: nymResponse.value.codes[0].claimed,
              };
            }
          }
        } catch (error) {
          console.error(`Error fetching Paynym info for ${pc}:`, error);
        }
      }

      setPaynymInfoCache(newCache);
    };

    fetchPaynymInfo();
  }, [walletID, wallets]);

  // Handle payment code returned from AddContactScreen
  useEffect(() => {
    const paymentCode = route.params?.paymentCode;
    if (paymentCode) {
      // Clear the param to prevent re-processing
      navigation.setParams({ paymentCode: undefined });

      // Process the payment code
      setIsLoading(true);
      _addContact(paymentCode).finally(() => {
        setIsLoading(false);
      });
    }
  }, [route.params?.paymentCode]);

  const toolTipActions = useMemo(() => actionKeys, []);

  const shortenContactName = (name: string): string => {
    if (name.length < 20) return name;
    return name.substr(0, 10) + '...' + name.substr(name.length - 10, 10);
  };

  const onToolTipPress = async (id: any, pc: string) => {
    try {
      setIsLoading(true);
      await _onToolTipPress(id, pc);
    } catch (error: any) {
      presentAlert({ message: error.message });
    } finally {
      setIsLoading(false);
    }
  };

  const _onToolTipPress = async (id: any, pc: string) => {
    switch (String(id)) {
      case String(Actions.copyToClipboard): {
        Clipboard.setString(pc);
        break;
      }
      case String(Actions.rename): {
        const newName = await prompt(loc.bip47.rename, loc.bip47.provide_name, true, 'plain-text');
        if (!newName) return;

        counterpartyMetadata[pc] = { label: newName };
        setReload(Math.random());
        await saveToDisk();
        break;
      }
      case String(Actions.pay): {
        const cl = new ContactList();
        // ok its a SilentPayments code/regular address, no need to check for notif tx, ok to just send
        if (cl.isBip352PaymentCodeValid(pc) || cl.isAddressValid(pc)) {
          _navigateToSend(pc);
          return;
        }
        // check if notif tx is in place and has confirmations
        const foundWallet = wallets.find(
          (w) => w.getID() === walletID,
        ) as unknown as HDSegwitBech32Wallet;
        assert(foundWallet, 'Internal error: cant find walletID ' + walletID);
        const notifTx = foundWallet.getBIP47NotificationTransaction(pc);
        if (!notifTx) {
          await _addContact(pc);
          return;
        }
        if (!notifTx.confirmations) {
          // when we just sent the confirmation tx and it havent confirmed yet
          presentAlert({ message: loc.bip47.notification_tx_unconfirmed });
          return;
        }
        _navigateToSend(pc);
        break;
      }
      case String(Actions.hide): {
        if (!(await confirm(loc.wallets.details_are_you_sure))) {
          return;
        }
        counterpartyMetadata[pc] = { label: counterpartyMetadata[pc]?.label, hidden: true };
        setReload(Math.random());
        await saveToDisk();
        break;
      }
      default:
        break;
    }
  };

  const _navigateToSend = (pc: string) => {
    const previousRoute = state.routes[state.routes.length - 2];

    if (previousRoute.name === ('SendDetails' as string)) {
      const popToAction = StackActions.popTo('SendDetails', {
        walletID,
        addRecipientParams: {
          address: pc,
        },
        merge: true,
      });
      navigation.dispatch(popToAction);
    } else {
      navigation.navigate('SendDetailsRoot', {
        paymentCode: pc,
        walletID,
      });
    }
  };

  const renderItem = (pc: string, index: number) => {
    if (counterpartyMetadata?.[pc]?.hidden) return null; // hidden contact, do not render

    const color = uint8ArrayToHex(sha256(pc)).substring(0, 6);

    // Display priority: user-defined label > nymName (if claimed) > payment code
    const displayName = shortenContactName(
      counterpartyMetadata?.[pc]?.label ||
      (paynymInfoCache[pc]?.claimed ? paynymInfoCache[pc]?.nymName : pc) ||
      pc
    );

    if (previousRouteName === 'SendDetails') {
      return (
        <TouchableOpacity onPress={() => onToolTipPress(Actions.pay, pc)}>
          <View style={styles.contactRowContainer}>
            <PaynymAvatar paymentCode={pc} size={35} placeholderColor={color} />
            <View style={styles.contactRowBody}>
              <Text testID={`ContactListItem${index}`} style={[styles.contactRowNameText, { color: colors.labelText }]}>  
                {displayName}
              </Text>
            </View>
          </View>
          <View style={styles.stick} />
        </TouchableOpacity>
      );
    }

    return (
      <ToolTipMenu
        actions={toolTipActions}
        onPressMenuItem={(item: any) => onToolTipPress(item, pc)}
        isButton={true}
        isMenuPrimaryAction={true}
      >
        <View style={styles.contactRowContainer}>
          <PaynymAvatar paymentCode={pc} size={35} placeholderColor={color} />
          <View style={styles.contactRowBody}>
            <Text testID={`ContactListItem${index}`} style={[styles.contactRowNameText, { color: colors.labelText }]}>
              {displayName}
            </Text>
          </View>
        </View>
        <View style={styles.stick} />
      </ToolTipMenu>
    );
  };

  const followContactIfClaimed = async (
    wallet: HDSegwitBech32Wallet,
    targetPaymentCode: string,
  ) => {
    try {
      if (__DEV__) console.log('[FOLLOW DEBUG] Starting auto-follow for:', targetPaymentCode);

      // Step 1: Check if user's Paynym is claimed
      const userPaymentCode = wallet.getBIP47PaymentCode();
      const userNymResponse = await PaynymDirectory.nym(userPaymentCode);
      const userIsClaimed = userNymResponse.value?.codes?.[0]?.claimed || false;
      if (__DEV__) console.log('[FOLLOW DEBUG] User Paynym claimed:', userIsClaimed);

      if (!userIsClaimed) {
        if (__DEV__) console.log('[FOLLOW DEBUG] User Paynym not claimed, skipping follow');
        return;
      }

      // Step 2: Check if contact's Paynym is claimed
      const contactNymResponse = await PaynymDirectory.nym(targetPaymentCode);
      const contactIsClaimed =
        contactNymResponse.value?.codes?.[0]?.claimed || false;
      if (__DEV__) console.log('[FOLLOW DEBUG] Contact Paynym claimed:', contactIsClaimed);

      if (!contactIsClaimed) {
        if (__DEV__) console.log('[FOLLOW DEBUG] Contact Paynym not claimed, skipping follow');
        return;
      }

      // Step 3: Both are claimed - proceed with follow
      if (__DEV__) console.log('[FOLLOW DEBUG] Both Paynyms claimed, proceeding with follow');

      // Get token
      const tokenResponse = await PaynymDirectory.token(userPaymentCode);
      if (!tokenResponse.value) {
        if (__DEV__) console.error('[FOLLOW DEBUG] Failed to get token:', tokenResponse.message);
        return;
      }

      // Generate signature (reuse claim signature method)
      const signature = await wallet.generatePaynymClaimSignature(
        tokenResponse.value.token,
      );
      if (__DEV__) console.log('[FOLLOW DEBUG] Signature generated');

      // Follow
      const followResponse = await PaynymDirectory.follow(
        tokenResponse.value.token,
        signature,
        targetPaymentCode,
      );
      if (__DEV__) console.log('[FOLLOW DEBUG] Follow response status:', followResponse.statusCode);

      if (followResponse.statusCode === 200) {
        if (__DEV__) console.log('[FOLLOW DEBUG] Successfully followed Paynym!');
      } else {
        if (__DEV__) console.error('[FOLLOW DEBUG] Follow failed:', followResponse.message);
      }
    } catch (error) {
      if (__DEV__) console.error('[FOLLOW DEBUG] Auto-follow error:', error);
    }
  };

  const onAddContactPress = () => {
    // Navigate to a screen where user can enter payment code or scan QR
    navigation.navigate('AddContactScreen', { walletID });
  };

  const _addContact = async (newPc: string) => {
    const foundWallet = wallets.find(w => w.getID() === walletID) as unknown as HDSegwitBech32Wallet;
    assert(foundWallet, 'Internal error: cant find walletID ' + walletID);

    if (counterpartyMetadata[newPc]?.hidden) {
      // contact already present, just need to unhide it
      counterpartyMetadata[newPc].hidden = false;
      await saveToDisk();
      setReload(Math.random());
      return;
    }

    const cl = new ContactList();

    if (cl.isAddressValid(newPc)) {
      // this is not a payment code but a regular onchain address. pretending its a payment code and adding it
      foundWallet.addBIP47Receiver(newPc);
      await saveToDisk();
      setReload(Math.random());
      // Auto-follow if both Paynyms are claimed
      await followContactIfClaimed(foundWallet, newPc);
      return;
    }

    if (!cl.isPaymentCodeValid(newPc)) {
      presentAlert({ message: loc.bip47.invalid_pc });
      return;
    }

    if (cl.isBip352PaymentCodeValid(newPc)) {
      // ok its a SilentPayments code, notification tx is not needed, just add it to recipients:
      foundWallet.addBIP47Receiver(newPc);
      await saveToDisk();
      setReload(Math.random());
      // Auto-follow if both Paynyms are claimed
      await followContactIfClaimed(foundWallet, newPc);
      return;
    }

    setIsLoading(true);

    const notificationTx = foundWallet.getBIP47NotificationTransaction(newPc);

    if (notificationTx && notificationTx.confirmations > 0) {
      // we previously sent notification transaction to him, so just need to add him to internals
      foundWallet.addBIP47Receiver(newPc);
      await foundWallet.syncBip47ReceiversAddresses(newPc); // so we can unwrap and save all his possible addresses
      // (for a case if already have txs with him, we will now be able to label them on tx list)
      await saveToDisk();
      setReload(Math.random());
      // Auto-follow if both Paynyms are claimed
      await followContactIfClaimed(foundWallet, newPc);
      return;
    }

    if (notificationTx && notificationTx.confirmations === 0) {
      // for a rare case when we just sent the confirmation tx and it havent confirmed yet
      presentAlert({ message: loc.bip47.notification_tx_unconfirmed });
      return;
    }

    // need to send notif tx:

    setLoadingText('Fetching UTXO...');
    await foundWallet.fetchUtxo();
    setLoadingText('Fetching fees...');
    const fees = await BlueElectrum.estimateFees();
    setLoadingText('Fetching change address...');
    const changeAddress = await foundWallet.getChangeAddressAsync();
    setLoadingText('Crafting notification transaction...');
    if (foundWallet.getUtxo().length === 0) {
      // no balance..?
      presentAlert({ message: loc.send.details_total_exceeds_balance });
      return;
    }
    const { tx, fee } = foundWallet.createBip47NotificationTransaction(foundWallet.getUtxo(), newPc, fees.fast, changeAddress);

    if (!tx) {
      presentAlert({ message: loc.bip47.failed_create_notif_tx });
      return;
    }

    setLoadingText('');
    if (
      await confirm(
        loc.bip47.onchain_tx_needed,
        `${loc.send.create_fee}: ${formatBalance(fee, BitcoinUnit.BTC)} (${satoshiToLocalCurrency(fee)}). `,
      )
    ) {
      setLoadingText('Broadcasting...');
      try {
        await foundWallet.broadcastTx(tx.toHex());
        foundWallet.addBIP47Receiver(newPc);
        presentAlert({ message: loc.bip47.notif_tx_sent });
        txMetadata[tx.getId()] = { memo: loc.bip47.notif_tx };
        await saveToDisk();
        setReload(Math.random());
        await new Promise((resolve) => setTimeout(resolve, 5000)); // tx propagate on backend so our fetch will actually get the new tx
        // Auto-follow if both Paynyms are claimed
        await followContactIfClaimed(foundWallet, newPc);
      } catch (error) {
        console.error('Notification transaction broadcast failed:', error);
        presentAlert({ message: `${loc.bip47.failed_create_notif_tx}: ${error instanceof Error ? error.message : String(error)}` });
      }
      setLoadingText('Fetching transactions...');
      await foundWallet.fetchTransactions();
      setLoadingText('');
    }
  };

  if (isLoading) {
    return (
      <View style={styles.container}>
        <BlueLoading />
        <Text>{loadingText}</Text>
      </View>
    );
  }

  return (
    <SafeArea style={styles.container}>
      {!walletID ? (
        <Text>Internal error</Text>
      ) : (
        <View style={styles.sectionListContainer}>
          <SectionList
            sections={data}
            keyExtractor={(item, index) => item + index}
            renderItem={({ item, index }) => renderItem(item, index)}
          />
        </View>
      )}

      <Button title={loc.bip47.add_contact} onPress={onAddContactPress} />
    </SafeArea>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionListContainer: { flex: 1, width: '100%' },
  circle: {
    width: 35,
    height: 35,
    borderRadius: 25,
  },
  contactRowBody: { flex: 6, justifyContent: 'center', top: -3 },
  contactRowNameText: { marginLeft: 10, fontSize: 16 },
  contactRowContainer: { flexDirection: 'row', padding: 15 },
  stick: { borderStyle: 'solid', borderWidth: 0.5, borderColor: 'gray', opacity: 0.5, top: 0, left: -10, width: '110%' },
});
