// What Nexus's device routes answer the approval page, and the one place those shapes are written, so that a browser
// check of the page can answer the page's calls itself from them.
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
export const PAGE_PATH = '/apps/nexus/approve';
export const API_PENDING = '/apps/nexus/api/device/pending';
export const API_APPROVE = '/apps/nexus/api/device/approve';
export const API_DENY = '/apps/nexus/api/device/deny';

/** What GET device/pending answers for a sign-in that is waiting for the owner. */
export const PENDING = { code: CODE, identity: 'agents', label: 'lab-m', expiresAt: 1790000600000 };

/** What POST device/approve and device/deny answer when they work. */
export const APPROVED = { result: 'approved', code: CODE, identity: 'agents', label: 'lab-m' };
export const DENIED = { result: 'denied', code: CODE, identity: 'agents', label: 'lab-m' };

/** What every route answers with a refusal, and the words the page is shown for one. */
export const GONE = { error: 'That code has expired or has already been used.' };
export const NOT_FOUND = { error: 'There is no sign-in with that code.' };
