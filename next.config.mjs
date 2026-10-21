import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

export default phase => ({
  ...(phase === PHASE_DEVELOPMENT_SERVER ? {} : { output: 'export' }),
  poweredByHeader: false,
  agentRules: false,
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  images: { unoptimized: true },
});
