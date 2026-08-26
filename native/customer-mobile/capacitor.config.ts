import type { CapacitorConfig } from '@capacitor/cli';

const devServerUrl = process.env.CAP_SERVER_URL || 'http://127.0.0.1:8021/apps/customer-mobile/';

const config: CapacitorConfig = {
  appId: 'ai.firstmate.customer',
  appName: 'FirstMate Customer',
  webDir: 'www',
  server: {
    url: devServerUrl,
    cleartext: true
  },
  android: {
    allowMixedContent: true
  }
};

export default config;
