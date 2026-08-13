import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.sooya.app',
  appName: 'SOOYA',
  webDir: 'packages/web/dist',
  ios: {
    contentInset: 'automatic',
    preferredContentMode: 'mobile'
  },
  plugins: {
    Keyboard: { resize: 'body' },
    SplashScreen: { launchAutoHide: true }
  }
};

export default config;

