import React, { useState } from 'react';
import { View, StyleSheet, Image } from 'react-native';

interface PaynymAvatarProps {
  paymentCode: string;
  size?: number;
  style?: any;
  placeholderColor?: string; // Optional hex color (without #) for loading state
}

const PaynymAvatar: React.FC<PaynymAvatarProps> = ({
  paymentCode,
  size = 64,
  style,
  placeholderColor,
}) => {
  const [error, setError] = useState(false);

  // Construct avatar URL directly without calling API
  // Existing contacts are already registered, and new ones can be created elsewhere
  const avatarUrl = `https://paynym.rs/${paymentCode}/avatar`;

  if (error) {
    // Fallback to colored circle if placeholderColor is provided
    if (placeholderColor) {
      return (
        <View
          style={[
            styles.container,
            styles.placeholder,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: '#' + placeholderColor,
            },
            style,
          ]}
        />
      );
    }
    // Fallback if no placeholderColor provided — use a neutral grey circle
    return (
      <View
        style={[
          styles.container,
          styles.fallback,
          { width: size, height: size, borderRadius: size / 2 },
          style,
        ]}
      />
    );
  }

  // Render PNG avatar (paynym.rs serves PNG)
  return (
    <View
      style={[
        styles.container,
        { width: size, height: size, borderRadius: size / 2 },
        style,
      ]}
    >
      <Image
        source={{ uri: avatarUrl }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        onError={(error: any) => {
          console.log('Image loading error:', error);
          setError(true);
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    backgroundColor: '#f5f5f5',
  },
  placeholder: {
    // Empty style for placeholder circles
  },
  fallback: {
    backgroundColor: '#9CA3AF',
    borderWidth: 2,
    borderColor: '#6B7280',
  },
});

export default PaynymAvatar;
