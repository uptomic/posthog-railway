"use strict";

function railwayRedisOptions(url, options) {
  // Explicit connection choices always win, including invalid values rejected by ioredis.
  if (options?.family !== undefined || options?.host !== undefined || options?.path !== undefined) {
    return options;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return options;
  }
  if (
    !["redis:", "rediss:"].includes(parsed.protocol) ||
    ["family", "host", "path"].some((key) => parsed.searchParams.has(key)) ||
    !parsed.hostname.toLowerCase().replace(/\.$/, "").endsWith(".railway.internal")
  ) {
    return options;
  }
  // Node's numeric family=0 resolves either A or AAAA records; it is not a DNS override.
  return { ...options, family: 0 };
}

module.exports = { railwayRedisOptions };
