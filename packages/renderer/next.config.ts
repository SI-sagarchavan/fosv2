import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@fanos/dsl", "@fanos/tokens"],
  // Source files use NodeNext-style `.js` import specifiers. Webpack does not
  // rewrite those to `.ts`/`.tsx` unless we tell it to.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".tsx", ".ts", ".jsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
