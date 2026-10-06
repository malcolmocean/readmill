// ECMAScript 5.1 — paste into Karabiner-Elements' JavaScript generator
//
// PCsensor FootSwitch (default output: pedals send a / b / c)
//   a        tap  → tab
//   b        tap  → fn+space (dictation)
//            hold → command  (hold b, tap a repeatedly = cmd-tab cycling)
//   c        tap  → return
//            hold → shift    (hold c, tap a = shift-tab; hold b+c, tap a = cmd-shift-tab)

var DEVICE = {
  type: 'device_if',
  identifiers: [{ vendor_id: 13651, product_id: 45057 }]
};

var ALONE_TIMEOUT_MS = 1000;   // max hold for a b/c press to still count as a tap

// Base manipulator: from a pedal key, any modifiers pass through, device-scoped.
// Keys in `spec` are merged on top (and override defaults, e.g. conditions).
function pedal(from, spec) {
  var m = {
    type: 'basic',
    from: { key_code: from, modifiers: { optional: ['any'] } },
    conditions: [DEVICE]
  };
  for (var k in spec) m[k] = spec[k];
  return m;
}

function main() {
  return {
    description: 'FootSwitch: a=tab, b=dictation/hold cmd, c=enter/hold shift',
    description_notes: [
      '- hold b + tap a: cmd-tab (repeat a to cycle)',
      '- hold b+c + tap a: cmd-shift-tab (reverse)',
      '- hold c + tap a: shift-tab'
    ],
    manipulators: [
      // a: tab (picks up any held pedal modifiers)
      pedal('a', { to: [{ key_code: 'tab' }] }),

      // b: command while held; dictation if tapped alone
      pedal('b', {
        to: [{ key_code: 'left_command', lazy: true }],
        to_if_alone: [{ key_code: 'spacebar', modifiers: ['fn'] }],
        parameters: { 'basic.to_if_alone_timeout_milliseconds': ALONE_TIMEOUT_MS }
      }),

      // c: shift while held; return if tapped alone
      pedal('c', {
        to: [{ key_code: 'left_shift', lazy: true }],
        to_if_alone: [{ key_code: 'return_or_enter' }],
        parameters: { 'basic.to_if_alone_timeout_milliseconds': ALONE_TIMEOUT_MS }
      })
    ]
  };
}

main()
