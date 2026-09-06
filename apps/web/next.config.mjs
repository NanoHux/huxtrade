/** @type {import('next').NextConfig} */

// The browser talks only to this app; /api/* is proxied on to the API service
// from inside the container.
//
// The alternative — pointing the browser straight at the API — bakes an
// absolute host into the client bundle at build time (NEXT_PUBLIC_API_URL).
// That address has to be reachable from wherever the page is opened, so a
// machine on the other side of a NAT loaded the page fine and then had every
// button fail against an address it could not route to, and any IP change
// meant a rebuild. Proxying keeps it same-origin: one port to expose, no CORS,
// and nothing host-specific compiled in.
const apiTarget = process.env.API_INTERNAL_URL || "http://localhost:4000";

const nextConfig = {
  transpilePackages: ["@huxtrade/shared-types"],
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiTarget}/api/:path*` }];
  }
};

export default nextConfig;
