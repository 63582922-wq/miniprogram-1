/**
 * Legacy JavaScript token aliases.
 * Keep these aligned with styles/precision-a.wxss so older code cannot
 * reintroduce the retired dark-green / blue-gray theme.
 */

module.exports = {
  // === COLORS ===
  color: {
    // Brand
    primary: '#191816',
    accent: '#DE6E3F',
    accentSoft: '#F4DED2',

    // Neutrals (warm gray scale)
    text: {
      primary: '#191816',
      secondary: '#706D67',
      tertiary: '#9A958C',
      inverse: '#E9E4DD',
    },

    bg: {
      page: '#E9E4DD',
      card: '#E9E4DD',
      elevated: '#F2EEE8',
      sunken: '#E2DCD3',
      dark: '#171717',
    },

    border: {
      default: '#C9C1B7',
      light: '#DDD6CC',
      strong: '#BBB1A4',
    },

    // Status
    status: {
      urgent: '#A93E2E',
      urgentBg: '#F2DDD8',
      active: '#191816',
      activeBg: '#E2DCD3',
      warning: '#946022',
      warningBg: '#F1E5D4',
      idle: '#9A958C',
      idleBg: '#E2DCD3',
      complete: '#706D67',
      completeBg: '#DDD6CC',
    },
  },

  // === TYPOGRAPHY ===
  font: {
    family: {
      sans: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", "Helvetica Neue", sans-serif',
      mono: '"SF Mono", "JetBrains Mono", "Menlo", monospace',
      display: '"STSongti-SC-Regular", "Songti SC", "STSong", "Source Han Serif SC", "Noto Serif CJK SC", "SimSun", serif',
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
    sm: '0 1rpx 4rpx rgba(25,24,22,.04)',
    base: '0 2rpx 12rpx rgba(25,24,22,.06)',
    md: '0 4rpx 20rpx rgba(25,24,22,.08)',
    lg: '0 8rpx 32rpx rgba(25,24,22,.12)',
    fab: '0 6rpx 20rpx rgba(225,93,58,.25)',
  },
};
