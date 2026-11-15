// Encrypted notes and key wraps, made by the real @nexus/crypto, for the server's tests. The server stores and serves what a
// device sends and never opens it, so these are what a device really sends.
//
// HOW THEY WERE MADE (once, then pinned here; the server's tests need no crypto library):
//   packages/crypto built with `npm ci && npm run build`, then a short script called
//   encryptNote(key, { vaultId: "vault-1", noteId: <id>, kid: 1 }, { path, text }) with a test vault key of the bytes 00 01 ... 1f,
//   checked that decryptNote gave the same path and text back, and wrote the blob out as base64. The two wraps are the
//   recovery wrap and the password wrap pinned in docs/FORMAT.md section 10, converted from hex to base64.
// `path` and `text` are what is inside each blob. A test uses them only to look for them in what the server keeps, says or
// logs, where they must never be found. They are made up for these tests.

/** The vault key's number in every blob here. */
export const KID = 1;

/** The vault id every blob and wrap here was made with (the server keeps it beside the wraps). */
export const VAULT_ID = "vault-1";

/** Version 1 of note n-1. */
export const GARDEN_V1 = {
  id: "n-1",
  path: "Projects/Garden plan.md",
  text: "Beds along the south fence.\nCompost corner by the gate.\n",
  blob: "AQAAAAHzQQHseY6Wcf3EUvqz2J/mHgzNSwSjs1CY8ri0TYdGpWDsf5W75a901Tvq5YVOPZZw8K0EnXdvqltp09ykM56lBnYB7g3G4ENYs9zoyjyitvlu0y5K/vZIKOHx0btELplwCY4g0U6vmdfKT/V2usyUCM0nQhZCYhZ4mA+d/qcgJKPFAC+r6s0+w2eIlJ6PvcYhC1aW5wd63YNLvzFvRRkXt4pyp0DkCJhXZ2QRcaYJ1mGOKwsQWDoKNP04LEwXFwcS9goxe2G5LjZH9dOAufLfwJjXct5lShf1zBicl8B7g5udhJtM8MSys0yI73T1fPYyAZd2QaPYu/rewXtUtvMOgOheYTKuyHt+dD54/NmmqDDX78eeNbZvWSTSz+IQgPrg6QkEkG1DeA==",
};

/** Version 2 of note n-1: the same note after one more line was added. */
export const GARDEN_V2 = {
  id: "n-1",
  path: "Projects/Garden plan.md",
  text: "Beds along the south fence.\nCompost corner by the gate.\nOrder seed potatoes in March.\n",
  blob: "AQAAAAFHhqhDFPA/bJCsCNq4pyzNxo2r7F0DrrY5k6V1zUF8hkzjDxrHzwlsZy0fBm5JOLHUd7MAIC1VGT4JrJUuiq2fE5iDzQ6a5nECTPGk3JKPBWjiZ1PCRmSLEwEgXK5MS6pQW0GCDX5q3zLlMUo4SfJVJvxxkdLrPDJ65szw5pMeGyPX2toDvnPLEYbokMxDU/BQafnKGyRruM+3egUZsm7xBoMJGdvb15JIc7Panq/Z8yZRj+hRhvJu3RPXkYa83coHAb4U9ZdFfeBFtgd1yTxGUSdJT2gw0jFxE/GW3ynOzexlwoTIgbF3U4ceBy7qJ/voqxZAF4tDr2EWEDSkvzKCggdDV5eInDgZME02tdjEa3PCh6zukhknc7OkuOhfeO3dmdA4LPOa2w==",
};

/** A second note, with accents, symbols and a script that is not Latin in its text. */
export const PODCAST_V1 = {
  id: "n-2",
  path: "Ideas/Podcast names.md",
  text: "Three possible names for the show: Slow Radio, Small Hours, Night Shelf.\nCafé ✨ 日本語\n",
  blob: "AQAAAAFCnSIgoPHuwwlaoOkpG9kN07Qkp5kGLRX7Oaf01dmYyMq0UJY0swq71G2A7P4kg/mdr9LbbAKh1UMbYFHC8bFDEVQsm0JjSgGmkwriYugdbaAxD/4sH8dsBt6lz9h94Mm8gmnKx/sq6wdKRwewFRorvxyjpHQUsOU1CjNafeKaIysfFw+NZ9wt1y5AyMk2xLcLR+7RNloIuIzdvGkiz9BJYHhUApU2le1UP8Zk8QJEMJ472xXR0ceFhbkeEiAE0ZpGdh9f7WceZJdc9SIggQwTy2TVLAhykVvjDZbzNVfQHCushAiYhJL2+lKQtmfB9wnytrVTMk7HO9By8/HD8ofx99znW1H447iQdip32ud21sMDuceYRW0K1y4Y8Zvi8+xV/6JsLY6M5A==",
};

/** The recovery wrap of docs/FORMAT.md section 10, as base64. */
export const RECOVERY_WRAP = "AQJAQUJDREVGR0hJSktMTU5PUFFSU1RVVldrhUO1GMjMrCdexSKzW38CKgAtNSDho03s1uf0NQYmiuR02qNroSG9IXFADrE4xJk=";

/** The password wrap of docs/FORMAT.md section 10, as base64. */
export const PASSWORD_WRAP = "AQMAAQAAAAAAAwAAAAFgYWJjZGVmZ2hpamtsbW5vQEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXqr9cLKjvVIoDLYRYO0Z6cl9+oIBquukCOataQ1tAWASfO4GOWlMf1lhXflYNjusP";

// The same podcast note as PODCAST_V1, encrypted under other vault keys, for the tests that need a blob whose header names
// another kid. Made the same way as the blobs above (the same vault id, note id, record and test vault key bytes 00 01 ... 1f),
// with kid 0, 7 and 4294967295; each was opened again by decryptNote. Each is 301 bytes, the smallest a new blob can be.

/** Under vault key number 0, the smallest kid. */
export const PODCAST_KID_0 = {
  id: "n-2",
  kid: 0,
  blob: "AQAAAACLtZjGMFoKlYGpQcA1czGwpOKjAS37tzHBNnPyY2nwYt9qwN5TD05J0pE9oIzQLk+JBkXV4AkqcHEodxRI3TEy/dATrO3iKhh78drNfasiKnVccWdIN1kHde3143O5GSNAG9IGfmnspZFVMUh93tcRs86C2VXMPePBekuzY0wcB3TMc6/4ruBpAhKNOfiFp8kak55r/jQkV8rNdghWv2gzoyoG6PMtu0T16bnM0ubECIqslvCAIFVtNXE5bCJ87UPhGu4ElTZHd5AQagHwhzNeC+l81Zk/ksNCibQ7NfwLHdLC5IY0dSppYpUHCGG4KHVl0BzDzIuzWExpEkp9v/4nRlSobNpHP878olZaNg7wm5xACBoOJoJnsi453cdEQFblowUzI8fGmA==",
};

/** Under vault key number 7. */
export const PODCAST_KID_7 = {
  id: "n-2",
  kid: 7,
  blob: "AQAAAActzTlL0ca24QNqZnU6VDE9Ieh4gYV8nxBXk/8ACP20N5MZGR5KNaAhSCOnOFvXPmeXJPtqxa3RF8NNw/eie493pYL/QphQ6BqXGBBj7vmppMjXkcdnqJpFE96BQjd55b6vIoeG5qfDs9Kmqs06vviZjnWLQxeHx7mFPLtR+nGP/mYIrWoFz8LFnOV2CBBId6AzHTB3DXuVfG0T6fWko/kw4L98SMBwL4BLcIhP4wDhoJOST+Gmh18Gnv1i9aNsDx17YBf2RBpJtLvKZtR6O95mThI5eJCJpCzUdfF5k8WNz8qsTMnsLEYFzVGJCOhOeYN3JcnhRw6hEh38SzQmLDia/RcxUJk14nasreMdsryCbWhX/PD3qopcvMnSdwWadmVfgwjViAqKJg==",
};

/** Under vault key number 4294967295, the largest kid. */
export const PODCAST_KID_MAX = {
  id: "n-2",
  kid: 4294967295,
  blob: "Af////8xUvKWAFgvcmfHDXoVSQc4hLqBbq4XWjX/dh1HR7LycO+8ZDwcR4ur7khfmlx6zwjW28ake4Ka+rIGto3eyiJTuxoHPScxeDE5xwdpjwZsdlnaKjeYO54DiasiH6I/rCmBak4+wLeZdRgVaxDUInu0rdrzlNqS8brdA3qL+qEq4s0Y91sQKjeGXPNVjjmfve9MrvrZCqCwxaw3KjVnxwtZ1ePoedMhNJGN01FgTDtkxDy4swnBrpc835kRwnjHys4OLh3+Na3vRv/zDp/QHcBiLL02fPuH7/Ov4kSTJbLqCyy2kOKb5+FgZ1SnRKu2KVCgRu0SRZHSJnARx+5Vx40V8HmCLMcJQmXbvc7ofIPP52PQF+LbX9dRUA8DXi33NfA29sKWIK9a8w==",
};

// Recovery wraps made by the real @nexus/crypto, for the tests that keep a wrap under more than one kid, or replace one.
// Each wraps the same test vault key (00 01 ... 1f) under a second Recovery Key (the bytes 80 81 ... 9f), for vault-1 and
// the kid in its name, and was opened again by unwrapVaultKeyWithRecoveryKey. RECOVERY_WRAP above is under kid 1 and the
// first Recovery Key, so RECOVERY_WRAP_KID_1_AGAIN is what the owner keeps after changing the Recovery Key.

/** The Recovery wrap for kid 0. */
export const RECOVERY_WRAP_KID_0 = "AQIvwq33HKHvaIGxRu+FlHXAAfRzbeHFCbHnaavS1S2+/1sRl9MvBDoKcYA1xWXJlEB4Z38Di8ZNt0Sj4csg3Cjafo4n7IxBeBo=";

/** The Recovery wrap for kid 1 under the second Recovery Key: it replaces RECOVERY_WRAP. */
export const RECOVERY_WRAP_KID_1_AGAIN = "AQKy7fWecBWMVzoKflt8a7MfPtql00Mx7veBC3Z/SvUPOtvOy21AXGq+vxT2mYQqmA/E8+/0rlRx4SIklaKzwXC7W+rBnXkK4zA=";

/** The Recovery wrap for kid 2. */
export const RECOVERY_WRAP_KID_2 = "AQIcD8OzTEOPjbdgnjMXkUKmKjIYVE+HsXe4I4bOYQTlpQ/mIgruBpiFBEGd46LF01vCVNeq2rX5Zsz26Bid+aGNaIA9SmvjUc0=";

/** The Recovery wrap for kid 4294967295. */
export const RECOVERY_WRAP_KID_MAX = "AQKuy7V4eaQ+MMsJWUOCZJn4NIkP4JivX2SDpEwf1d30IsZ1U0uloV9NWKrAB9RY3NG5fCt2qUWuVqdFWvrp7Jo4w2OfRlXYbWM=";
