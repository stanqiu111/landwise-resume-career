import { hostedAppFromEnvironment } from '../server/hosted-app.js';

// Vercel's /api/:path* rewrite preserves the incoming URL for Express routing.
// All account credentials are read only in this server runtime.
export default hostedAppFromEnvironment();
