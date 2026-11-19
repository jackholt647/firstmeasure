/**
 * safeFetch's address rules (docs/architecture/request-security.md#fetching-urls):
 * private, loopback, link-local, reserved and mapped forms are refused, and
 * ordinary public IPv4 and IPv6 addresses are allowed. GP-32: a single
 * BlockList holding the IPv6 rule ::ffff:0:0/96 matched every IPv4 address,
 * so every website with an A record was "not public" and the signup logo
 * lookup never found a logo.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isPublicAddress, safeFetch, SafeFetchError } from "../platform/security/safe-fetch.js";

test("public IPv4 and IPv6 addresses are allowed", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "172.66.147.243", "104.20.23.154", "23.215.0.136", "2606:4700:10::ac42:93f3", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("private, loopback, link-local, reserved and mapped addresses are refused", () => {
  for (const address of [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.8", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "64:ff9b::7f00:1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "not-an-address", ""
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("addresses that are not public are refused before any request", async () => {
  for (const url of ["http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://localhost/", "http://metadata.internal/"]) {
    await assert.rejects(safeFetch(url), (error: unknown) => error instanceof SafeFetchError && error.code === "address_not_public", url);
  }
  await assert.rejects(safeFetch("ftp://example.com/"), (error: unknown) => error instanceof SafeFetchError && error.code === "protocol_not_allowed");
  await assert.rejects(safeFetch("http://example.com:8080/"), (error: unknown) => error instanceof SafeFetchError && error.code === "port_not_allowed");
});
