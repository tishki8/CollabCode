import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { trustHops } from "./app";

async function ipSeenBy(hops: number, xff: string | undefined, peer = "10.0.0.1") {
  const app = Fastify({ trustProxy: trustHops(hops) });
  app.get("/ip", async (req) => req.ip);
  const res = await app.inject({ url: "/ip", remoteAddress: peer, headers: xff ? { "x-forwarded-for": xff } : {} });
  await app.close();
  return res.body;
}

describe("trustHops: which client address rate limits see", () => {
  it("with one trusted proxy, uses the address the proxy appended and ignores what the client claimed", async () => {
    // the client sent "6.6.6.6"; our web proxy appended the real address "203.0.113.5"
    expect(await ipSeenBy(1, "6.6.6.6, 203.0.113.5")).toBe("203.0.113.5");
    expect(await ipSeenBy(1, "203.0.113.5")).toBe("203.0.113.5");
  });
  it("a client cannot dodge limits by rotating a fake X-Forwarded-For", async () => {
    const seen = new Set<string>();
    for (const fake of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) seen.add(await ipSeenBy(1, `${fake}, 203.0.113.5`));
    expect([...seen]).toEqual(["203.0.113.5"]);
  });
  it("with no proxy configured the header is ignored entirely", async () => {
    expect(await ipSeenBy(0, "6.6.6.6, 203.0.113.5", "198.51.100.2")).toBe("198.51.100.2");
  });
  it("falls back to the peer when there is no header", async () => {
    expect(await ipSeenBy(1, undefined, "198.51.100.3")).toBe("198.51.100.3");
  });
});
