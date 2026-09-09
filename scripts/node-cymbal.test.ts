import { expect, test } from "bun:test";
import { resolveCymbalEndpoints } from "../images/node/cymbal-dns.cjs";
import { patchCymbalSource } from "../images/node/apply-overlay.cjs";
import guard from "../images/node/guard.json";

test("resolves Railway IPv4 and IPv6 into valid HTTP authorities", async () => {
  const endpoints = await resolveCymbalEndpoints("cymbal.railway.internal", {
    lookup: async (host: string, options: object) => {
      expect(host).toBe("cymbal.railway.internal");
      expect(options).toEqual({ all: true, family: 0 });
      return [{ address: "fd00::1", family: 6 }, { address: "10.0.0.1", family: 4 }, { address: "fd00::1", family: 6 }];
    },
  });
  expect(endpoints).toEqual(["[fd00::1]", "10.0.0.1"]);
  for (const endpoint of endpoints) expect(new URL(`http://${endpoint}:3305`).port).toBe("3305");
});
test("preserves public DNS policy and propagates private DNS failures", async () => {
  expect(await resolveCymbalEndpoints("cymbal.example.com", { resolve4: async () => ["1.2.3.4"] })).toEqual(["1.2.3.4"]);
  await expect(resolveCymbalEndpoints("cymbal.railway.internal", { lookup: async () => { throw new Error("ENOTFOUND"); } })).rejects.toThrow("ENOTFOUND");
});
test("patches only the verified deployed resolver and rejects upstream drift", () => {
  const source = "async function defaultDnsResolve(hostname) {\n    return promises_1.default.resolve4(hostname);\n}";
  expect(patchCymbalSource(source, guard.cymbal.dnsFunctionSha256)).toContain("resolveCymbalEndpoints(hostname)");
  expect(() => patchCymbalSource(source.replace("resolve4", "resolve6"), guard.cymbal.dnsFunctionSha256)).toThrow("NODE_CYMBAL_DNS_FUNCTION_DRIFT");
});

test("does not treat suffix lookalikes as Railway hosts", async () => {
  expect(await resolveCymbalEndpoints("cymbal.railway.internal.example.com", { resolve4: async () => ["1.2.3.4"] })).toEqual(["1.2.3.4"]);
});
