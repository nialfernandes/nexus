# nexus: build notes

Read this before the `.jsx` files. Nexus keeps Nial's linked notes and gives each person, agent and app its own identity, token and folder rights. These 24 boards cover the approval page, encrypted setup and adding a device. Card nialfernandes #747.

## Rules for every screen

- Build everything on each board exactly as shown. If the code does not do something shown yet, build it. Before building, compare each board with the code and list anything missing or different as questions.
- Boards are 375 wide, drawn mobile first, light only (dark is off). The plugin screens are drawn the same way and respond up to a desktop modal by the estate's build rules.
- The slab look, like Cue and Clip, in Nexus teal #2FCDB8 with ink text. Colours, spaces, radii and fonts come from the estate's tokens; no colour is written out by hand.
- Codes are one box per character and check on the last character. There are no Approve, Check or Unlock buttons.
- Names, labels and codes on a board are sample data until a device sends real ones; anything a device sends is shown as text, never as markup.
- The `.jsx` is authoritative for values (inline styles, exact px and hex); the PNG in `png/` is authoritative for the look.
- Not part of this set: web notes screens (writing and linked notes) have no board.

## Files

| Board | Name | Code | Picture |
|---|---|---|---|
| 1 | approve a device | `01-approve-a-device-light.jsx` | `png/01-approve-a-device-light@2x.png` |
| 2 | allowed | `02-allowed-light.jsx` | `png/02-allowed-light@2x.png` |
| 3 | denied | `03-denied-light.jsx` | `png/03-denied-light@2x.png` |
| 4 | code ran out | `04-code-ran-out-light.jsx` | `png/04-code-ran-out-light@2x.png` |
| 5 | code used | `05-code-used-light.jsx` | `png/05-code-used-light@2x.png` |
| 6 | setup, start | `06-setup-start-light.jsx` | `png/06-setup-start-light@2x.png` |
| 7 | setup, recovery key | `07-setup-recovery-key-light.jsx` | `png/07-setup-recovery-key-light@2x.png` |
| 8 | setup, recovery key saved | `08-setup-recovery-key-saved-light.jsx` | `png/08-setup-recovery-key-saved-light@2x.png` |
| 9 | setup, type-back | `09-setup-type-back-light.jsx` | `png/09-setup-type-back-light@2x.png` |
| 10 | setup, type-back wrong | `10-setup-type-back-wrong-light.jsx` | `png/10-setup-type-back-wrong-light@2x.png` |
| 11 | setup, password off | `11-setup-password-off-light.jsx` | `png/11-setup-password-off-light@2x.png` |
| 12 | setup, password on | `12-setup-password-on-light.jsx` | `png/12-setup-password-on-light@2x.png` |
| 13 | setup, done | `13-setup-done-light.jsx` | `png/13-setup-done-light@2x.png` |
| 14 | new device, waiting | `14-new-device-waiting-light.jsx` | `png/14-new-device-waiting-light@2x.png` |
| 15 | approving device, type the device code | `15-approving-device-type-the-device-code-light.jsx` | `png/15-approving-device-type-the-device-code-light@2x.png` |
| 16 | approving device, wrong device code | `16-approving-device-wrong-device-code-light.jsx` | `png/16-approving-device-wrong-device-code-light@2x.png` |
| 17 | approving device, matching code | `17-approving-device-matching-code-light.jsx` | `png/17-approving-device-matching-code-light@2x.png` |
| 18 | new device, type the matching code | `18-new-device-type-the-matching-code-light.jsx` | `png/18-new-device-type-the-matching-code-light@2x.png` |
| 19 | new device, wrong matching code | `19-new-device-wrong-matching-code-light.jsx` | `png/19-new-device-wrong-matching-code-light@2x.png` |
| 20 | new device, unlocked | `20-new-device-unlocked-light.jsx` | `png/20-new-device-unlocked-light@2x.png` |
| 21 | signed in but locked | `21-signed-in-but-locked-light.jsx` | `png/21-signed-in-but-locked-light@2x.png` |
| 22 | locked, wrong Recovery Key | `22-locked-wrong-recovery-key-light.jsx` | `png/22-locked-wrong-recovery-key-light@2x.png` |
| 23 | new device, the wait ran out | `23-new-device-the-wait-ran-out-light.jsx` | `png/23-new-device-the-wait-ran-out-light@2x.png` |
| 24 | approving device, not allowed | `24-approving-device-not-allowed-light.jsx` | `png/24-approving-device-not-allowed-light@2x.png` |

## Build notes, board by board

### Board 1: approve a device (`01-approve-a-device-light.jsx`)

**Build notes: approve a device**

What it is: the one screen the Nexus site has. A device (Obsidian on someone's laptop) asked for a sign-in and handed Nial a link with a code in it. Nial opens the link on any phone or computer and this page loads. Page files: apps/public/nexus/approve.html, approve.css and approve.js, using the estate tokens of the rest of the site.

On load the page reads the code from the address, then asks Nexus what is being asked: the label the device sent (for example Obsidian on Nial's MacBook) and the identity (nial). Both are set as plain text, never as markup. The question line is built as: Allow <label> to use Nexus as <identity>?

Device code: shown read-only so it can be matched against the device's own screen, one box per character, grouped 4, 4, 2, filled sand-grey #F2F1EE with no outline. Nothing is typed on this screen. Boxes are selectable text, and the whole code has an accessible label read out as one string.

Buttons: Allow is the main ink pill, Deny is the quiet outline pill, right aligned, 8 px apart, Allow first. After the first tap both buttons go dim and ignore taps so nothing can be sent twice. Allow leads to board 2, Deny to board 3. A code Nexus says has run out or was used leads to boards 4 or 5, shown instead of this card.

Words: the ten-minute line is taken from the expiry Nexus sends, not hard coded. Fewest words: do not add explanations.

Look: drawn mobile first at 375 wide in the Aus Apps slab look, the same family as Cue and Clip. Teal slab header (#2FCDB8, ink text), lowercase title in Unbounded 22 px weight 800 on one line, one line under it in Instrument Sans 13 px at 85 percent ink, bottom corners 28 px. Ground #EEEDEA. White cards, radius 16, a 1 px soft shadow (0 1px 3px at 8 percent ink), 14 px padding, 12 px between things inside a card. Body text Instrument Sans 15/21 in ink #0F1013; small lines 13/17 in #3A3A40. Buttons are 30 px high pills, 13 px Instrument Sans weight 600: the main one is ink #0F1013 with white words, the quiet one has a 1.5 px outline of ink at 25 percent. Light only. Three colours on the screen at most: teal, ink and the sand-grey ground; red and the cream warning box are only for faults and warnings.

On a desktop this is not a second design. It is the same screen: the page widens to a centred column of at most 720 px and the card keeps its phone proportions (the estate's desktop build rules). Never draw or build a separate desktop layout.

Every code and key on this board is a made-up example. Never ship them and never copy them into tests as real values.

### Board 2: allowed (`02-allowed-light.jsx`)

**Build notes: allowed**

Shown after Allow succeeds. The card from board 1 is replaced by this one: a 36 px teal circle with an ink tick, then the line Obsidian on Nial's MacBook can use Nexus now (device label as text, from the same answer as board 1), then the quiet line saying the page can be closed.

There is nothing to tap. No buttons, no links. The device picks the approval up by itself on its next check, so this page has no job left.

The tick circle is the only teal on the card apart from the slab. Title in the slab reads allowed, the line under it reads Obsidian is in.

Look: drawn mobile first at 375 wide in the Aus Apps slab look, the same family as Cue and Clip. Teal slab header (#2FCDB8, ink text), lowercase title in Unbounded 22 px weight 800 on one line, one line under it in Instrument Sans 13 px at 85 percent ink, bottom corners 28 px. Ground #EEEDEA. White cards, radius 16, a 1 px soft shadow (0 1px 3px at 8 percent ink), 14 px padding, 12 px between things inside a card. Body text Instrument Sans 15/21 in ink #0F1013; small lines 13/17 in #3A3A40. Buttons are 30 px high pills, 13 px Instrument Sans weight 600: the main one is ink #0F1013 with white words, the quiet one has a 1.5 px outline of ink at 25 percent. Light only. Three colours on the screen at most: teal, ink and the sand-grey ground; red and the cream warning box are only for faults and warnings.

On a desktop this is not a second design. It is the same screen: the page widens to a centred column of at most 720 px and the card keeps its phone proportions (the estate's desktop build rules). Never draw or build a separate desktop layout.

### Board 3: denied (`03-denied-light.jsx`)

**Build notes: denied**

Shown after Deny. The device is not given a token and nothing is shared. The circle is neutral grey (#E4E2DD) with an ink cross, not red, because Deny is a choice and not a fault.

Card lines: Obsidian on Nial's MacBook was not given a token, then the quiet line suggesting starting again from Obsidian if Nial changed his mind. No buttons, nothing else to tap.

Slab title denied, slab line Nothing was shared.

Look: drawn mobile first at 375 wide in the Aus Apps slab look, the same family as Cue and Clip. Teal slab header (#2FCDB8, ink text), lowercase title in Unbounded 22 px weight 800 on one line, one line under it in Instrument Sans 13 px at 85 percent ink, bottom corners 28 px. Ground #EEEDEA. White cards, radius 16, a 1 px soft shadow (0 1px 3px at 8 percent ink), 14 px padding, 12 px between things inside a card. Body text Instrument Sans 15/21 in ink #0F1013; small lines 13/17 in #3A3A40. Buttons are 30 px high pills, 13 px Instrument Sans weight 600: the main one is ink #0F1013 with white words, the quiet one has a 1.5 px outline of ink at 25 percent. Light only. Three colours on the screen at most: teal, ink and the sand-grey ground; red and the cream warning box are only for faults and warnings.

On a desktop this is not a second design. It is the same screen: the page widens to a centred column of at most 720 px and the card keeps its phone proportions (the estate's desktop build rules). Never draw or build a separate desktop layout.

### Board 4: code ran out (`04-code-ran-out-light.jsx`)

**Build notes: code ran out**

Shown instead of board 1 when Nexus answers 410 (the code expired). A code stops working ten minutes after it was made. Use Nexus's own words in the card if it sends them, otherwise the words drawn.

Light red circle (#FDECEE) with a red clock outline (#C62020). No buttons ever appear again for this code, so there is nothing to tap. The quiet line tells Nial to ask for a new one on the device.

Slab title code ran out, slab line Ten minutes is up.

Look: drawn mobile first at 375 wide in the Aus Apps slab look, the same family as Cue and Clip. Teal slab header (#2FCDB8, ink text), lowercase title in Unbounded 22 px weight 800 on one line, one line under it in Instrument Sans 13 px at 85 percent ink, bottom corners 28 px. Ground #EEEDEA. White cards, radius 16, a 1 px soft shadow (0 1px 3px at 8 percent ink), 14 px padding, 12 px between things inside a card. Body text Instrument Sans 15/21 in ink #0F1013; small lines 13/17 in #3A3A40. Buttons are 30 px high pills, 13 px Instrument Sans weight 600: the main one is ink #0F1013 with white words, the quiet one has a 1.5 px outline of ink at 25 percent. Light only. Three colours on the screen at most: teal, ink and the sand-grey ground; red and the cream warning box are only for faults and warnings.

On a desktop this is not a second design. It is the same screen: the page widens to a centred column of at most 720 px and the card keeps its phone proportions (the estate's desktop build rules). Never draw or build a separate desktop layout.

### Board 5: code used (`05-code-used-light.jsx`)

**Build notes: code used**

Shown instead of board 1 when Nexus answers 404 or 410 because the code was already answered. A code can be answered once. No buttons, so it cannot be tapped twice.

Light red circle with a red cross. Card lines: That code was already used, then a quiet line saying a code works once and to ask for a new one on the device.

Slab title code used, slab line One answer per code.

Look: drawn mobile first at 375 wide in the Aus Apps slab look, the same family as Cue and Clip. Teal slab header (#2FCDB8, ink text), lowercase title in Unbounded 22 px weight 800 on one line, one line under it in Instrument Sans 13 px at 85 percent ink, bottom corners 28 px. Ground #EEEDEA. White cards, radius 16, a 1 px soft shadow (0 1px 3px at 8 percent ink), 14 px padding, 12 px between things inside a card. Body text Instrument Sans 15/21 in ink #0F1013; small lines 13/17 in #3A3A40. Buttons are 30 px high pills, 13 px Instrument Sans weight 600: the main one is ink #0F1013 with white words, the quiet one has a 1.5 px outline of ink at 25 percent. Light only. Three colours on the screen at most: teal, ink and the sand-grey ground; red and the cream warning box are only for faults and warnings.

On a desktop this is not a second design. It is the same screen: the page widens to a centred column of at most 720 px and the card keeps its phone proportions (the estate's desktop build rules). Never draw or build a separate desktop layout.

### Board 6: setup, start (`06-setup-start-light.jsx`)

**Build notes: setup, start**

First thing a fresh install of the plugin shows. Step 1 of 4, written in the slab line (Step 1 of 4.). Title set up nexus.

Content: the plain promise that notes are scrambled on this device before they leave it and the server only holds scrambled text. Then the cream warning box (#FFF3D6, radius 10, 10/12 padding) headed Not yet audited. This box stays on this screen until an outside security review has been done; the card that removes it must name that review.

Last paragraph tells Nial a Recovery Key comes next, that it is the only way back in if every signed-in device is lost, and that Nexus cannot reset it.

Buttons: Cancel (quiet) leaves the plugin signed out and unencrypted and closes the modal. Continue (main) goes to board 7. Both right aligned, 8 px apart.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Look: drawn mobile first at 375 wide in the Aus Apps slab look, the same family as Cue and Clip. Teal slab header (#2FCDB8, ink text), lowercase title in Unbounded 22 px weight 800 on one line, one line under it in Instrument Sans 13 px at 85 percent ink, bottom corners 28 px. Ground #EEEDEA. White cards, radius 16, a 1 px soft shadow (0 1px 3px at 8 percent ink), 14 px padding, 12 px between things inside a card. Body text Instrument Sans 15/21 in ink #0F1013; small lines 13/17 in #3A3A40. Buttons are 30 px high pills, 13 px Instrument Sans weight 600: the main one is ink #0F1013 with white words, the quiet one has a 1.5 px outline of ink at 25 percent. Light only. Three colours on the screen at most: teal, ink and the sand-grey ground; red and the cream warning box are only for faults and warnings.

On a desktop this is not a second design. It is the same screen: the page widens to a centred column of at most 720 px and the card keeps its phone proportions (the estate's desktop build rules). Never draw or build a separate desktop layout.

### Board 7: setup, recovery key (`07-setup-recovery-key-light.jsx`)

**Build notes: setup, recovery key**

Step 2 of 4. The key is made on this device and shown once. It is 14 groups of four characters. The panel (sand-grey #F2F1EE, radius 10, 12 px padding) shows them four to a row, evenly spaced, JetBrains Mono 14 px weight 600, last row two groups.

Copy key copies the whole key as one string with a space between groups. After a copy the pill reads Copied for two seconds. Nothing is stored anywhere the plugin could show it again.

The tick box (18 px, radius 5, 1.5 px outline) confirms Nial saved the key somewhere safe. The words say password manager or paper, never a named product. Continue is dim (40 percent) and ignores taps until the box is ticked.

Back (quiet) returns to board 6 and the key already shown stays the same; it is not remade.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Look: drawn mobile first at 375 wide in the Aus Apps slab look, the same family as Cue and Clip. Teal slab header (#2FCDB8, ink text), lowercase title in Unbounded 22 px weight 800 on one line, one line under it in Instrument Sans 13 px at 85 percent ink, bottom corners 28 px. Ground #EEEDEA. White cards, radius 16, a 1 px soft shadow (0 1px 3px at 8 percent ink), 14 px padding, 12 px between things inside a card. Body text Instrument Sans 15/21 in ink #0F1013; small lines 13/17 in #3A3A40. Buttons are 30 px high pills, 13 px Instrument Sans weight 600: the main one is ink #0F1013 with white words, the quiet one has a 1.5 px outline of ink at 25 percent. Light only. Three colours on the screen at most: teal, ink and the sand-grey ground; red and the cream warning box are only for faults and warnings.

Every code and key on this board is a made-up example. Never ship them and never copy them into tests as real values.

### Board 8: setup, recovery key saved (`08-setup-recovery-key-saved-light.jsx`)

**Build notes: setup, recovery key saved**

The same screen as board 7 with the box ticked. The tick box fills teal (#2FCDB8) with a 1.5 px ink outline and an ink tick. Continue is now full strength and goes to board 9. Back goes to board 6.

Ticking and unticking is allowed at any time; Continue follows the box.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Look: drawn mobile first at 375 wide in the Aus Apps slab look, the same family as Cue and Clip. Teal slab header (#2FCDB8, ink text), lowercase title in Unbounded 22 px weight 800 on one line, one line under it in Instrument Sans 13 px at 85 percent ink, bottom corners 28 px. Ground #EEEDEA. White cards, radius 16, a 1 px soft shadow (0 1px 3px at 8 percent ink), 14 px padding, 12 px between things inside a card. Body text Instrument Sans 15/21 in ink #0F1013; small lines 13/17 in #3A3A40. Buttons are 30 px high pills, 13 px Instrument Sans weight 600: the main one is ink #0F1013 with white words, the quiet one has a 1.5 px outline of ink at 25 percent. Light only. Three colours on the screen at most: teal, ink and the sand-grey ground; red and the cream warning box are only for faults and warnings.

Every code and key on this board is a made-up example. Never ship them and never copy them into tests as real values.

### Board 9: setup, type-back (`09-setup-type-back-light.jsx`)

**Build notes: setup, type-back**

Step 3 of 4, title check key. The plugin asks for three of the 14 groups, named by number (group 3, group 8, group 12 here; the plugin picks three at random each time and names them the same way). It proves the key was written down right.

Each group is four boxes in a row with the group name in JetBrains Mono 11 px caps to the left. Boxes are 44 px square. The first empty box has the teal outline and the caret.

No Check button: the three groups are compared as soon as the last of the twelve characters is in. Groups count left to right, top row first, as on board 7. Capitals and small letters both count.

The quiet line under the boxes explains how groups are counted. Back (quiet) returns to board 7.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Codes: one box per character, never one long field. 44 px high, radius 8, JetBrains Mono 15 px weight 600, grouped 4, 4, 2 with 12 px between groups and 4 px inside a group. Empty box: white with a 1.5 px outline of ink at 14 percent. The box being typed in: 2 px teal outline and a 2 px ink caret. A wrong code turns every box red (fill #FDECEE, 2 px outline #D1293D). Typing the last character, or pasting the whole code into any box, checks it straight away. There is no Verify button anywhere (the estate's code-box rule). Capitals and small letters both count, spaces are ignored.

Every code and key on this board is a made-up example. Never ship them and never copy them into tests as real values.

### Board 10: setup, type-back wrong (`10-setup-type-back-wrong-light.jsx`)

**Build notes: setup, type-back wrong**

A group that does not match turns its four boxes red (group 8 here) and the red line under the boxes names it: Group 8 does not match. Look at your saved key and retype it.

The other groups keep what was typed. Retyping is allowed with no limit. As soon as the wrong group is edited its boxes go back to plain white and the line goes away. The next full set is checked again straight away.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Codes: one box per character, never one long field. 44 px high, radius 8, JetBrains Mono 15 px weight 600, grouped 4, 4, 2 with 12 px between groups and 4 px inside a group. Empty box: white with a 1.5 px outline of ink at 14 percent. The box being typed in: 2 px teal outline and a 2 px ink caret. A wrong code turns every box red (fill #FDECEE, 2 px outline #D1293D). Typing the last character, or pasting the whole code into any box, checks it straight away. There is no Verify button anywhere (the estate's code-box rule). Capitals and small letters both count, spaces are ignored.

Every code and key on this board is a made-up example. Never ship them and never copy them into tests as real values.

### Board 11: setup, password off (`11-setup-password-off-light.jsx`)

**Build notes: setup, password off**

Step 4 of 4, title password. Optional. The switch is off by default and the cream warning box is always showing, whichever way the switch is, as ruled on nialfernandes #717.

Switch: 38 by 22 px, track #C9C9D0 when off and teal when on, white 18 px knob. Row has a 1 px hairline above and below. Words: Unlock with a password, with the quiet line Off is safer. Off by default.

Finish setup works with the switch off and goes to board 13. Back (quiet) returns to board 8.

Why the warning: the password wrap only ever sits beside the recovery wrap on the server, so anyone who gets a copy of the encrypted notes can try guesses against a password without limit. A remembered password is far weaker than the Recovery Key.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Look: drawn mobile first at 375 wide in the Aus Apps slab look, the same family as Cue and Clip. Teal slab header (#2FCDB8, ink text), lowercase title in Unbounded 22 px weight 800 on one line, one line under it in Instrument Sans 13 px at 85 percent ink, bottom corners 28 px. Ground #EEEDEA. White cards, radius 16, a 1 px soft shadow (0 1px 3px at 8 percent ink), 14 px padding, 12 px between things inside a card. Body text Instrument Sans 15/21 in ink #0F1013; small lines 13/17 in #3A3A40. Buttons are 30 px high pills, 13 px Instrument Sans weight 600: the main one is ink #0F1013 with white words, the quiet one has a 1.5 px outline of ink at 25 percent. Light only. Three colours on the screen at most: teal, ink and the sand-grey ground; red and the cream warning box are only for faults and warnings.

### Board 12: setup, password on (`12-setup-password-on-light.jsx`)

**Build notes: setup, password on**

With the switch on, two password boxes open under it: Password (focused, teal outline) and Type it again (placeholder Same password). Text typed is hidden as round dots. Boxes are 40 px high, radius 10.

Finish setup is dim (40 percent) and ignores taps until both boxes hold the same password. Passwords are NFKC normalised before use, so the same words typed on another keyboard still match. The warning box stays, now headed Pick a long one.

Turning the switch back off closes the two boxes and forgets what was typed.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Look: drawn mobile first at 375 wide in the Aus Apps slab look, the same family as Cue and Clip. Teal slab header (#2FCDB8, ink text), lowercase title in Unbounded 22 px weight 800 on one line, one line under it in Instrument Sans 13 px at 85 percent ink, bottom corners 28 px. Ground #EEEDEA. White cards, radius 16, a 1 px soft shadow (0 1px 3px at 8 percent ink), 14 px padding, 12 px between things inside a card. Body text Instrument Sans 15/21 in ink #0F1013; small lines 13/17 in #3A3A40. Buttons are 30 px high pills, 13 px Instrument Sans weight 600: the main one is ink #0F1013 with white words, the quiet one has a 1.5 px outline of ink at 25 percent. Light only. Three colours on the screen at most: teal, ink and the sand-grey ground; red and the cream warning box are only for faults and warnings.

### Board 13: setup, done (`13-setup-done-light.jsx`)

**Build notes: setup, done**

Closing screen of setup, title all set. A teal tick circle, one line saying notes are scrambled on this device before they are sent and that the first sync starts when this is closed.

Summary panel (sand-grey, radius 10): Recovery Key / Saved by you, Password / Off or On to match step 4, Audit / Not yet audited. The Audit row stays until the outside review has been done.

Done (main) closes the modal and starts the first sync. There is no way back from here.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Look: drawn mobile first at 375 wide in the Aus Apps slab look, the same family as Cue and Clip. Teal slab header (#2FCDB8, ink text), lowercase title in Unbounded 22 px weight 800 on one line, one line under it in Instrument Sans 13 px at 85 percent ink, bottom corners 28 px. Ground #EEEDEA. White cards, radius 16, a 1 px soft shadow (0 1px 3px at 8 percent ink), 14 px padding, 12 px between things inside a card. Body text Instrument Sans 15/21 in ink #0F1013; small lines 13/17 in #3A3A40. Buttons are 30 px high pills, 13 px Instrument Sans weight 600: the main one is ink #0F1013 with white words, the quiet one has a 1.5 px outline of ink at 25 percent. Light only. Three colours on the screen at most: teal, ink and the sand-grey ground; red and the cream warning box are only for faults and warnings.

### Board 14: new device, waiting (`14-new-device-waiting-light.jsx`)

**Build notes: new device, waiting**

A new device that has signed in as the owner but has no key yet. It makes a device code from its own public key and shows it here, then polls Nexus for the approval. The code lasts ten minutes. Slab title new device, slab line Waiting for approval.

The code is read-only here: one box per character, sand-grey, grouped 4, 4, 2, so it can be read out to the other device. The status line has an 8 px teal dot and Waiting. The code works for 10 minutes. The dot does not pulse.

Cancel (quiet) stops the wait and leaves the device signed in but locked (board 21).

Steps for Nial are in the card text: on a device already signed in, open Nexus settings, choose Approve a device, and it will ask for this code.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Look: drawn mobile first at 375 wide in the Aus Apps slab look, the same family as Cue and Clip. Teal slab header (#2FCDB8, ink text), lowercase title in Unbounded 22 px weight 800 on one line, one line under it in Instrument Sans 13 px at 85 percent ink, bottom corners 28 px. Ground #EEEDEA. White cards, radius 16, a 1 px soft shadow (0 1px 3px at 8 percent ink), 14 px padding, 12 px between things inside a card. Body text Instrument Sans 15/21 in ink #0F1013; small lines 13/17 in #3A3A40. Buttons are 30 px high pills, 13 px Instrument Sans weight 600: the main one is ink #0F1013 with white words, the quiet one has a 1.5 px outline of ink at 25 percent. Light only. Three colours on the screen at most: teal, ink and the sand-grey ground; red and the cream warning box are only for faults and warnings.

Every code and key on this board is a made-up example. Never ship them and never copy them into tests as real values.

### Board 15: approving device, type the device code (`15-approving-device-type-the-device-code-light.jsx`)

**Build notes: approving device, type the device code**

Shown on a device that already has the key (Nial's laptop). Slab title approve device, slab line names the new device, for example Obsidian on Nial's iPhone, set as text.

The person TYPES the device code the new device is showing. Typing is the check, a click or a paste of a stored value cannot stand in for it, which is why Nexus's server cannot slip in a device of its own. The quiet line says nothing is sent to the new device until the code is right.

No Approve button: the code is checked when the tenth character is typed. Cancel (quiet) closes the modal and nothing is sent.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Codes: one box per character, never one long field. 44 px high, radius 8, JetBrains Mono 15 px weight 600, grouped 4, 4, 2 with 12 px between groups and 4 px inside a group. Empty box: white with a 1.5 px outline of ink at 14 percent. The box being typed in: 2 px teal outline and a 2 px ink caret. A wrong code turns every box red (fill #FDECEE, 2 px outline #D1293D). Typing the last character, or pasting the whole code into any box, checks it straight away. There is no Verify button anywhere (the estate's code-box rule). Capitals and small letters both count, spaces are ignored.

Every code and key on this board is a made-up example. Never ship them and never copy them into tests as real values.

### Board 16: approving device, wrong device code (`16-approving-device-wrong-device-code-light.jsx`)

**Build notes: approving device, wrong device code**

Wrong code: nothing is sealed or sent. All ten boxes turn red and the red line says so in plain words, with what to do next (read it again from its screen; if it keeps failing, cancel and start again on the new device).

Typing again is allowed straight away: the first edit clears the red and the next full ten characters are checked at once. There is no lock-out on this screen; the new device's own ten-minute limit is the limit.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Codes: one box per character, never one long field. 44 px high, radius 8, JetBrains Mono 15 px weight 600, grouped 4, 4, 2 with 12 px between groups and 4 px inside a group. Empty box: white with a 1.5 px outline of ink at 14 percent. The box being typed in: 2 px teal outline and a 2 px ink caret. A wrong code turns every box red (fill #FDECEE, 2 px outline #D1293D). Typing the last character, or pasting the whole code into any box, checks it straight away. There is no Verify button anywhere (the estate's code-box rule). Capitals and small letters both count, spaces are ignored.

Every code and key on this board is a made-up example. Never ship them and never copy them into tests as real values.

### Board 17: approving device, matching code (`17-approving-device-matching-code-light.jsx`)

**Build notes: approving device, matching code**

After the approval is sent, this device shows the matching code worked out from the sealed key and both device keys. Slab title approved, slab line Now go to the new device.

Read-only boxes, same look as board 14. The person types this code on the new device (board 18). The quiet line says if the new device does not accept it, do not use that device and approve it again from here.

Done (main) closes the modal.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Codes: one box per character, never one long field. 44 px high, radius 8, JetBrains Mono 15 px weight 600, grouped 4, 4, 2 with 12 px between groups and 4 px inside a group. Empty box: white with a 1.5 px outline of ink at 14 percent. The box being typed in: 2 px teal outline and a 2 px ink caret. A wrong code turns every box red (fill #FDECEE, 2 px outline #D1293D). Typing the last character, or pasting the whole code into any box, checks it straight away. There is no Verify button anywhere (the estate's code-box rule). Capitals and small letters both count, spaces are ignored.

Every code and key on this board is a made-up example. Never ship them and never copy them into tests as real values.

### Board 18: new device, type the matching code (`18-new-device-type-the-matching-code-light.jsx`)

**Build notes: new device, type the matching code**

The new device asks for the matching code and works out its own. The two must agree before the key is kept. Slab title matching code, slab line Your other device approved this one.

No Unlock button: the code is checked as soon as the tenth character is typed. Cancel (quiet) leaves the device locked.

The quiet line explains the check: it makes sure the key sent is the one the other device sealed.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Codes: one box per character, never one long field. 44 px high, radius 8, JetBrains Mono 15 px weight 600, grouped 4, 4, 2 with 12 px between groups and 4 px inside a group. Empty box: white with a 1.5 px outline of ink at 14 percent. The box being typed in: 2 px teal outline and a 2 px ink caret. A wrong code turns every box red (fill #FDECEE, 2 px outline #D1293D). Typing the last character, or pasting the whole code into any box, checks it straight away. There is no Verify button anywhere (the estate's code-box rule). Capitals and small letters both count, spaces are ignored.

Every code and key on this board is a made-up example. Never ship them and never copy them into tests as real values.

### Board 19: new device, wrong matching code (`19-new-device-wrong-matching-code-light.jsx`)

**Build notes: new device, wrong matching code**

A wrong code keeps the device locked and the key is not kept. All boxes red. A red box (#FDECEE, radius 10) headed This device stays locked says what it could mean (a typing slip, or the key swapped on its way) and what to do: try once more, then cancel and approve again from the other device.

Retyping is allowed. After the second wrong try the same screen stays; do not add a counter or lock-out here.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Codes: one box per character, never one long field. 44 px high, radius 8, JetBrains Mono 15 px weight 600, grouped 4, 4, 2 with 12 px between groups and 4 px inside a group. Empty box: white with a 1.5 px outline of ink at 14 percent. The box being typed in: 2 px teal outline and a 2 px ink caret. A wrong code turns every box red (fill #FDECEE, 2 px outline #D1293D). Typing the last character, or pasting the whole code into any box, checks it straight away. There is no Verify button anywhere (the estate's code-box rule). Capitals and small letters both count, spaces are ignored.

Every code and key on this board is a made-up example. Never ship them and never copy them into tests as real values.

### Board 20: new device, unlocked (`20-new-device-unlocked-light.jsx`)

**Build notes: new device, unlocked**

The matching code agreed. The key is kept in memory only and never written to disk. A teal tick circle, then one line: this device is unlocked and the first sync starts when this is closed.

Done (main) closes the modal and syncing starts. Nothing else to tap.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Look: drawn mobile first at 375 wide in the Aus Apps slab look, the same family as Cue and Clip. Teal slab header (#2FCDB8, ink text), lowercase title in Unbounded 22 px weight 800 on one line, one line under it in Instrument Sans 13 px at 85 percent ink, bottom corners 28 px. Ground #EEEDEA. White cards, radius 16, a 1 px soft shadow (0 1px 3px at 8 percent ink), 14 px padding, 12 px between things inside a card. Body text Instrument Sans 15/21 in ink #0F1013; small lines 13/17 in #3A3A40. Buttons are 30 px high pills, 13 px Instrument Sans weight 600: the main one is ink #0F1013 with white words, the quiet one has a 1.5 px outline of ink at 25 percent. Light only. Three colours on the screen at most: teal, ink and the sand-grey ground; red and the cream warning box are only for faults and warnings.

### Board 21: signed in but locked (`21-signed-in-but-locked-light.jsx`)

**Build notes: signed in but locked**

Reached when the owner's browser page allowed this device, which cannot hand over a key. Also reached by Cancel on board 14. Slab title locked, slab line Signed in, no key yet.

The person types or pastes the Recovery Key: 14 boxes of four characters, four to a row, the last row two boxes, JetBrains Mono 12 px. Pasting the whole key fills every box. The key is checked as soon as the fourteenth box is full, no Unlock button.

Use my password instead is an underlined text link. It only shows when a password was set up in step 4; if none was, leave it out entirely.

Cancel (quiet) closes the modal and the device stays locked.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Codes: one box per character, never one long field. 44 px high, radius 8, JetBrains Mono 15 px weight 600, grouped 4, 4, 2 with 12 px between groups and 4 px inside a group. Empty box: white with a 1.5 px outline of ink at 14 percent. The box being typed in: 2 px teal outline and a 2 px ink caret. A wrong code turns every box red (fill #FDECEE, 2 px outline #D1293D). Typing the last character, or pasting the whole code into any box, checks it straight away. There is no Verify button anywhere (the estate's code-box rule). Capitals and small letters both count, spaces are ignored.

Every code and key on this board is a made-up example. Never ship them and never copy them into tests as real values.

### Board 22: locked, wrong Recovery Key (`22-locked-wrong-recovery-key-light.jsx`)

**Build notes: locked, wrong Recovery Key**

A key whose check group does not agree is refused before anything is tried against the notes. The last group of the key is a check on the rest, so the red line names the last group first. Here the last box (Y8JX) is red.

Which box turns red: always the last group, because that is what the plugin can prove wrong. The other boxes keep what was typed and may be edited. The first edit clears the red.

Use my password instead and Cancel behave as on board 21.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Codes: one box per character, never one long field. 44 px high, radius 8, JetBrains Mono 15 px weight 600, grouped 4, 4, 2 with 12 px between groups and 4 px inside a group. Empty box: white with a 1.5 px outline of ink at 14 percent. The box being typed in: 2 px teal outline and a 2 px ink caret. A wrong code turns every box red (fill #FDECEE, 2 px outline #D1293D). Typing the last character, or pasting the whole code into any box, checks it straight away. There is no Verify button anywhere (the estate's code-box rule). Capitals and small letters both count, spaces are ignored.

Every code and key on this board is a made-up example. Never ship them and never copy them into tests as real values.

### Board 23: new device, the wait ran out (`23-new-device-the-wait-ran-out-light.jsx`)

**Build notes: new device, the wait ran out**

Shown when ten minutes pass with no approval, or the answer was lost. An approval is one use only, so it cannot be revived: Start again makes a new device code and returns to board 14.

Use Recovery Key (quiet) goes to board 21. Start again (main) is on the right. Light red clock circle on the card. Slab title wait ran out, slab line No approval in 10 minutes.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Look: drawn mobile first at 375 wide in the Aus Apps slab look, the same family as Cue and Clip. Teal slab header (#2FCDB8, ink text), lowercase title in Unbounded 22 px weight 800 on one line, one line under it in Instrument Sans 13 px at 85 percent ink, bottom corners 28 px. Ground #EEEDEA. White cards, radius 16, a 1 px soft shadow (0 1px 3px at 8 percent ink), 14 px padding, 12 px between things inside a card. Body text Instrument Sans 15/21 in ink #0F1013; small lines 13/17 in #3A3A40. Buttons are 30 px high pills, 13 px Instrument Sans weight 600: the main one is ink #0F1013 with white words, the quiet one has a 1.5 px outline of ink at 25 percent. Light only. Three colours on the screen at most: teal, ink and the sand-grey ground; red and the cream warning box are only for faults and warnings.

### Board 24: approving device, not allowed (`24-approving-device-not-allowed-light.jsx`)

**Build notes: approving device, not allowed**

Shown when Nexus answers 403 to an approval: the account this device is signed in as is not allowed to approve devices, only the owner's devices can. Plain words, nothing was sent to the new device.

Grey circle with an ink cross, not red, because nothing is broken. Close (main) is the only button.

Slab title not allowed, slab line This device cannot approve.

Where it lives: a screen in the Nexus Obsidian plugin, shown as a modal. On a phone it fills Obsidian's mobile modal; in desktop Obsidian it is the same layout in a centred modal about 560 px wide, with the teal band as the modal's top. Everything inside is exactly as drawn. Built with the plugin's own code, no web page involved.

Look: drawn mobile first at 375 wide in the Aus Apps slab look, the same family as Cue and Clip. Teal slab header (#2FCDB8, ink text), lowercase title in Unbounded 22 px weight 800 on one line, one line under it in Instrument Sans 13 px at 85 percent ink, bottom corners 28 px. Ground #EEEDEA. White cards, radius 16, a 1 px soft shadow (0 1px 3px at 8 percent ink), 14 px padding, 12 px between things inside a card. Body text Instrument Sans 15/21 in ink #0F1013; small lines 13/17 in #3A3A40. Buttons are 30 px high pills, 13 px Instrument Sans weight 600: the main one is ink #0F1013 with white words, the quiet one has a 1.5 px outline of ink at 25 percent. Light only. Three colours on the screen at most: teal, ink and the sand-grey ground; red and the cream warning box are only for faults and warnings.
