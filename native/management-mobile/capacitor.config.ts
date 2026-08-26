import type { CapacitorConfig } from '@capacitor/cli';

const devServerUrl = process.env.CAP_SERVER_URL || 'http://10.0.2.2:8021/apps/management-mobile/';

const config: CapacitorConfig = {
  appId: 'ai.firstmate.management',
  appName: 'FirstMate',
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
