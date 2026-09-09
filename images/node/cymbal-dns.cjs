"use strict";
const dns = require("node:dns/promises");

async function resolveCymbalEndpoints(hostname, resolver = dns) {
  if (!hostname.toLowerCase().replace(/\.$/, "").endsWith(".railway.internal")) {
    return resolver.resolve4(hostname);
  }
  const addresses = await resolver.lookup(hostname, { all: true, family: 0 });
  // Upstream interpolates each endpoint into an HTTP authority; IPv6 needs brackets.
  return [...new Set(addresses.map(({ address, family }) => family === 6 ? `[${address}]` : address))];
}
module.exports = { resolveCymbalEndpoints };
