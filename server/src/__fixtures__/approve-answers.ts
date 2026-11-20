// What Nexus's device routes answer the approval page, and the one place those shapes and words are written. The browser
// spec of the page (e2e/approve.spec.ts) answers the page's calls from them; approval-page-actions.test.ts
// takes the addresses and the words of a refusal from here.
//
// approval-page.test.ts holds these to the real handlers: it starts a real sign-in through the Worker and checks that
// each answer there has exactly the keys, with the kinds of value, written here. The shapes are the contract in
// identity-world.ts. No recorded answer existed before the routes did, so they are written by hand, and that test is
// what keeps them honest.
//
// This file imports nothing, so a browser test runner can read it as well.

/** The code on the approval link in the browser checks. */
export const CODE = 'K7QM-4XNP';

/** Where the page is opened, and the three calls it makes of Nexus. */
export const PAGE_PATH = '/nexus/approve';
export const API_PENDING = '/nexus/api/device/pending';
export const API_APPROVE = '/nexus/api/device/approve';
export const API_DENY = '/nexus/api/device/deny';

/**
 * What GET device/pending answers for a sign-in that is waiting for the owner and sent a key: `deviceKey` is the device's public key and
 * `deviceCode` the code the device shows for it (a real pair, the first of __fixtures__/device-keys.ts: approval-page.test.ts starts a
 * sign-in with this key and holds the server's `deviceCode` to this one). The page draws `deviceCode`, in groups of four.
 */
export const PENDING = {
  code: CODE, identity: 'agents', label: 'lab-m', expiresAt: 1790000600000,
  deviceKey: 'VDpzOdVNk5HCX/pw4SUzKXSdtlE1boxNAInF5nXJWAE=', deviceCode: 'NW18D-NK7HZ',
};

/** What it answers for a sign-in that sent no key: no key and no device code, and the page draws the sign-in code instead. */
export const PENDING_NO_KEY = { code: CODE, identity: 'agents', label: 'lab-m', expiresAt: 1790000600000, deviceKey: null, deviceCode: null };

/** What POST device/approve and device/deny answer when they work. */
export const APPROVED = { result: 'approved', code: CODE, identity: 'agents', label: 'lab-m' };
export const DENIED = { result: 'denied', code: CODE, identity: 'agents', label: 'lab-m' };

/**
 * What every route answers with a refusal. A code that is finished says why in `reason` and in its own words for each: the page draws
 * "code ran out" for expired and "code used" for used, each with the server's words. A code Nexus has no sign-in for has no reason.
 */
export const GONE = { error: 'That code was already used.', reason: 'used' };
export const GONE_EXPIRED = { error: 'That code has run out.', reason: 'expired' };
export const NOT_FOUND = { error: 'There is no sign-in with that code.' };
