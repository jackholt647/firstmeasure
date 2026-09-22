// Adapter to the portal's existing LiveKit UMD runtime (no second SDK instance).
export function getLogger(name) {
  if (window.LivekitClient?.getLogger) return window.LivekitClient.getLogger(name);
  return { debug(){}, trace(){}, info(){}, warn:console.warn.bind(console), error:console.error.bind(console), setLevel(){}, setDefaultLevel(){} };
}
