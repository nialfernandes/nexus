# nexus page: build notes

Read this before the `.jsx` files. These boards are the Nexus page on nialfernandes.com: the Nexus tile on the Apps page, who is connected, adding an agent, and giving the agent the key. Boards 1 and 2 are the approval page's first two boards, carried as the set's logo and rules boards.

## Rules for every screen

- Build everything on each board exactly as shown. If the code does not do something shown yet, build it. Before building, compare each board with the code and list anything missing or different as questions.
- Boards are 375 wide, drawn mobile first, light only (dark is off). The site shows the phone layout on a desktop: a centred column of at most 720 px, never a second layout.
- The slab look, like Cue and Clip, in Nexus teal #2FCDB8 with ink text. One slim top bar: the nexus mark, a thin divider and the lowercase title on the left; the page action then the Ask sparkle on the right (Settings has Aus Apps there instead of the sparkle). Settings is the last bottom tab.
- No dropdowns. Every change saves itself and shows an Undo bar.
- The vault key never reaches the website: the step that gives an agent the key happens in Obsidian (boards 31 and 31a). An agent with the key reads every note; there is no folder choice.
- Names, dates and codes on a board are sample data; anything the server sends is shown as text, never as markup.
- The `.jsx` is authoritative for values (inline styles, exact px and hex); the PNG in `png/` is authoritative for the look.

## Files

| Board | Name | Code | Picture |
|---|---|---|---|
| 1 | approve a device | `01-approve-a-device-light.jsx` | `png/01-approve-a-device-light@2x.png` |
| 2 | allowed | `02-allowed-light.jsx` | `png/02-allowed-light@2x.png` |
| 25 | Apps tile | `25-apps-tile-light.jsx` | `png/25-apps-tile-light@2x.png` |
| 26 | nexus, connected | `26-nexus-connected-light.jsx` | `png/26-nexus-connected-light@2x.png` |
| 26a | only you | `26a-only-you-light.jsx` | `png/26a-only-you-light@2x.png` |
| 26b | a device waiting | `26b-a-device-waiting-light.jsx` | `png/26b-a-device-waiting-light@2x.png` |
| 26c | removed | `26c-removed-light.jsx` | `png/26c-removed-light@2x.png` |
| 27 | add an agent | `27-add-an-agent-light.jsx` | `png/27-add-an-agent-light@2x.png` |
| 27a | name taken | `27a-name-taken-light.jsx` | `png/27a-name-taken-light@2x.png` |
| 28 | agent added, waiting | `28-agent-added-waiting-light.jsx` | `png/28-agent-added-waiting-light@2x.png` |
| 28a | agent joined, key to hand over | `28a-agent-joined-key-to-hand-over-light.jsx` | `png/28a-agent-joined-key-to-hand-over-light@2x.png` |
| 29 | an agent | `29-an-agent-light.jsx` | `png/29-an-agent-light@2x.png` |
| 29a | agent removed | `29a-agent-removed-light.jsx` | `png/29a-agent-removed-light@2x.png` |
| 30 | settings | `30-settings-light.jsx` | `png/30-settings-light@2x.png` |
| 31 | in Obsidian, give scribe the key | `31-in-obsidian-give-scribe-the-key-light.jsx` | `png/31-in-obsidian-give-scribe-the-key-light@2x.png` |
| 31a | in Obsidian, wrong agent code | `31a-in-obsidian-wrong-agent-code-light.jsx` | `png/31a-in-obsidian-wrong-agent-code-light@2x.png` |

full-screen boards: 25-apps-tile, 26-nexus-connected, 26a-only-you, 26b-a-device-waiting, 26c-removed, 27-add-an-agent, 27a-name-taken, 28-agent-added-waiting, 28a-agent-joined-key-to-hand-over, 29-an-agent, 29a-agent-removed, 30-settings, 31-in-obsidian-give-scribe-the-key, 31a-in-obsidian-wrong-agent-code
