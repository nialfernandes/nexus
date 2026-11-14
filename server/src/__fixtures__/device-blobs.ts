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
