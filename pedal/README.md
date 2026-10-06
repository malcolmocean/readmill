# Driving Readmill with a foot pedal

The pedal is a three-key PCsensor FootSwitch. Either of these works; they're two listings of
products that behave identically:
[one](https://link.amazon/B0fdfcOef), [the other](https://link.amazon/B0cuRZc1t).
Out of the box its pedals type `a`, `b` and `c`. [`footswitch.karabiner.js`](footswitch.karabiner.js)
uses Karabiner-Elements to turn them into:

| Pedal | Does | In Readmill |
| --- | --- | --- |
| tap **a** | Tab | next sentence (in the comment box: move to Save, then Cancel) |
| hold **c** + tap **a** | Shift+Tab | previous sentence |
| tap **c** | Enter | open the comment box / press the focused button |
| tap **b** | fn+Space, dictation | speak your comment |
| hold **b** + tap **a** | ⌘Tab | switch apps |

For the voice-to-text, fn+Space is wired up to [Wispr Flow](https://wisprflow.ai/r?MALCOLM63).

So a hands-free comment is: **c** to open the box, **b** to dictate, talk, **b** to stop, then
**a** **c** to save.

## Setup on a new Mac

1. **Install Karabiner-Elements.** Run `brew install --cask karabiner-elements`, or download it from karabiner-elements.pqrs.org.
2. **Grant permissions.** On first launch, macOS will prompt you for two things:
   - Allow the driver extension under System Settings → General → Login Items & Extensions → Driver Extensions.
   - Turn on Input Monitoring for `karabiner_grabber` and `karabiner_observer` under Privacy & Security.
   - Karabiner won't modify anything until both are approved. If something seems dead, these are the first thing to recheck.
3. **Enable the pedal.** Plug it in, and in Karabiner's **Devices** tab turn on **Modify events** for "FootSwitch (PCsensor)".
5. **Generate and add the rule.**
   - Paste the script into the JavaScript generator and copy the JSON it outputs.
   - Go to **Complex Modifications → Add your own rule**, paste the JSON, and save.
   - If you had earlier versions of these rules, delete them so they don't conflict.
6. **Check the app switcher binding.** Make sure AltTab's trigger is ⌘⇥ in its Preferences → Controls. If it isn't, the native macOS switcher answers instead.
7. **Verify.** Open **EventViewer** (from the Karabiner menu bar icon), hold B and tap A, and you should see `left_command` down followed by `tab`.

The pedal's a/b/c output is its factory default, so it needs no configuration of its own. If you ever reprogram it with PCsensor's utility, update the `from` keys to match. `ALONE_TIMEOUT_MS` at the top of the script is the knob to tune: a press of b or c held longer than that counts as a hold, not a tap.
