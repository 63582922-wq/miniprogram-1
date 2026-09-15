/**
 * Design Tokens - Hybrid Theme
 * Light background + Industrial data layout + numbering system
 *
 * Inspired by: Teenage Engineering (precision), Things 3 (calm),
 *              Hasselblad (industrial trust)
 */

module.exports = {
  // === COLORS ===
  color: {
    // Brand
    primary: '#1A1A2E',      // Deep ink - main text, primary buttons
    accent: '#E85D04',       // Safety orange - CTAs, urgent states
    accentSoft: '#FFF0E6',   // Orange tint background

    // Neutrals (warm gray scale)
    text: {
      primary: '#1A1A2E',
      secondary: '#5C5C6F',
      tertiary: '#9494A3',
      inverse: '#FAFAFA',
    },

    bg: {
      page: '#F5F4F1',        // Warm off-white
      card: '#FFFFFF',
      elevated: '#FFFFFF',
      sunken: '#ECEAE6',      // Slightly darker for insets
      dark: '#1A1A2E',        // For contrast sections
    },

    border: {
      default: '#E4E2DE',
      light: '#F0EEEA',
      strong: '#D1CEC8',
    },

    // Status
    status: {
      urgent: '#E85D04',
      urgentBg: '#FFF4EC',
      active: '#1A8754',
      activeBg: '#EEFBF3',
      warning: '#D4940A',
      warningBg: '#FFFBEB',
      idle: '#9494A3',
      idleBg: '#F5F4F1',
      complete: '#5C5C6F',
      completeBg: '#F0EEEA',
    },
  },

  // === TYPOGRAPHY ===
  font: {
    family: {
      sans: '-apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif',
      mono: '"SF Mono", "JetBrains Mono", "Menlo", monospace',
      display: '-apple-system, "SF Pro Display", "PingFang SC", sans-serif',
    },
    size: {
      '2xs': '20rpx',    // 10px - micro labels
      xs: '22rpx',       // 11px - captions, metadata
      sm: '24rpx',       // 12px - secondary text
      base: '28rpx',     // 14px - body
      md: '30rpx',       // 15px - titles
      lg: '36rpx',       // 18px - section headers
      xl: '44rpx',       // 22px - page titles
      '2xl': '56rpx',    // 28px - hero numbers
      '3xl': '72rpx',    // 36px - big display
    },
    weight: {
      light: '300',
      regular: '400',
      medium: '500',
      semibold: '600',
      bold: '700',
    },
    lineHeight: {
      tight: '1.2',
      normal: '1.5',
      relaxed: '1.7',
    },
  },

  // === SPACING ===
  space: {
    '2xs': '4rpx',
    xs: '8rpx',
    sm: '12rpx',
    base: '16rpx',
    md: '20rpx',
    lg: '24rpx',
    xl: '32rpx',
    '2xl': '40rpx',
    '3xl': '48rpx',
    '4xl': '64rpx',
  },

  // === BORDER RADIUS ===
  radius: {
    none: '0',
    sm: '4rpx',
    base: '8rpx',
    md: '12rpx',
    lg: '16rpx',
    full: '9999rpx',
  },

  // === SHADOWS ===
  shadow: {
    sm: '0 1rpx 4rpx rgba(26,26,46,.04)',
    base: '0 2rpx 12rpx rgba(26,26,46,.06)',
    md: '0 4rpx 20rpx rgba(26,26,46,.08)',
    lg: '0 8rpx 32rpx rgba(26,26,46,.12)',
    fab: '0 6rpx 20rpx rgba(232,93,4,.25)',
  },
};
