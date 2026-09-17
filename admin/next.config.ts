import type { NextConfig } from "next";

const config: NextConfig = {
  // The portal shows live client data. Caching a page that contains one
  // adviser's client list and serving it to a later request is exactly the
  // failure we cannot have, so nothing here is statically rendered.
  experimental: {
    staleTimes: { dynamic: 0, static: 0 },
  },
};

export default config;
