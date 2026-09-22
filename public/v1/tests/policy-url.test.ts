import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

const policyModule = import("../messaging/api.js");

test("policy URL address validation rejects private, special-use, and address-translation ranges", async () => {
  const { isPublicPolicyAddress } = await policyModule;
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b::a00:1",
    "2001:db8::1",
    "2002:0a00:0001::1",
    "fc00::1",
    "fe80::1",
    "ff02::1"
  ]) {
    assert.equal(isPublicPolicyAddress(address), false, `${address} must not be considered public`);
  }
  assert.equal(isPublicPolicyAddress("8.8.8.8"), true);
  assert.equal(isPublicPolicyAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicPolicyAddress("not-an-ip"), false);
});

test("policy URL verification pins one validated address and rejects mixed private DNS answers", async () => {
  const { verifyPublicPolicyUrl } = await policyModule;
  let resolveCalls = 0;
  let requestCalls = 0;
  let pinned: unknown = null;

  await verifyPublicPolicyUrl("https://policy.example/privacy", "https://policy.example", "Privacy policy", {
    resolve: async (hostname) => {
      resolveCalls += 1;
      assert.equal(hostname, "policy.example");
      return [{ address: "8.8.8.8", family: 4 }];
    },
    request: async (url, address) => {
      requestCalls += 1;
      assert.equal(url.href, "https://policy.example/privacy");
      pinned = address;
      return 204;
    }
  });

  assert.equal(resolveCalls, 1);
  assert.equal(requestCalls, 1);
  assert.deepEqual(pinned, { address: "8.8.8.8", family: 4 });

  let mixedRequestCalled = false;
  await assert.rejects(
    () => verifyPublicPolicyUrl("https://policy.example/privacy", "https://policy.example", "Privacy policy", {
      resolve: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 }
      ],
      request: async () => {
        mixedRequestCalled = true;
        return 204;
      }
    }),
    (error: any) => error?.code === "policy_url_invalid"
  );
  assert.equal(mixedRequestCalled, false);
});

test("policy URL verification rejects redirects, credentials, and non-HTTPS business sites", async () => {
  const { verifyPublicPolicyUrl } = await policyModule;
  const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }];

  await assert.rejects(
    () => verifyPublicPolicyUrl("https://policy.example/privacy", "https://policy.example", "Privacy policy", {
      resolve: publicResolver,
      request: async () => 302
    }),
    (error: any) => error?.code === "policy_url_unreachable" && error?.details?.status === 302
  );
  await assert.rejects(
    () => verifyPublicPolicyUrl("https://user:secret@policy.example/privacy", "https://policy.example", "Privacy policy", {
      resolve: publicResolver
    }),
    (error: any) => error?.code === "policy_url_invalid"
  );
  await assert.rejects(
    () => verifyPublicPolicyUrl("https://policy.example/privacy", "http://policy.example", "Privacy policy", {
      resolve: publicResolver
    }),
    (error: any) => error?.code === "policy_url_invalid"
  );
  await assert.rejects(
    () => verifyPublicPolicyUrl("https://policy.example/privacy", "https://user:secret@policy.example", "Privacy policy", {
      resolve: publicResolver
    }),
    (error: any) => error?.code === "policy_url_invalid"
  );
});

test("pinned HTTPS requests retain hostname verification, SNI, Host, and a one-address resolver", async () => {
  const { requestPinnedPolicyUrl } = await policyModule;
  let options: any = null;
  const fakeRequest = (requestOptions: any, callback: (response: any) => void) => {
    options = requestOptions;
    const request = new EventEmitter() as any;
    request.end = () => {
      const response = new EventEmitter() as any;
      response.statusCode = 206;
      response.destroy = () => {};
      callback(response);
    };
    return request;
  };

  const status = await requestPinnedPolicyUrl(
    new URL("https://policy.example:8443/privacy?version=2#ignored"),
    { address: "8.8.8.8", family: 4 },
    fakeRequest
  );
  assert.equal(status, 206);
  assert.equal(options.protocol, "https:");
  assert.equal(options.hostname, "policy.example");
  assert.equal(options.port, 8443);
  assert.equal(options.path, "/privacy?version=2");
  assert.equal(options.servername, "policy.example");
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  assert.equal(options.headers.Host, "policy.example:8443");

  await new Promise<void>((resolve, reject) => {
    options.lookup("policy.example", { all: false }, (error: Error | null, address: string, family: number) => {
      try {
        assert.equal(error, null);
        assert.equal(address, "8.8.8.8");
        assert.equal(family, 4);
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    options.lookup("policy.example", { all: true }, (error: Error | null, addresses: unknown) => {
      try {
        assert.equal(error, null);
        assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    options.lookup("rebound.example", { all: false }, (error: any) => {
      try {
        assert.equal(error?.code, "ENOTFOUND");
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    });
  });
});
