// ECMAScript 5.1 — paste into Karabiner-Elements' JavaScript generator
//
// PCsensor FootSwitch (default output: pedals send a / b / c)
//   a        tap  → tab
//   b        tap  → fn+space (dictation)
//            hold → command  (hold b, tap a repeatedly = cmd-tab cycling)
//   c        tap  → return (fires after a short double-tap window)
//            double tap → space
//            hold → shift    (hold b+c, tap a = cmd-shift-tab, reverse)

var DEVICE = {
  type: 'device_if',
  identifiers: [{ vendor_id: 13651, product_id: 45057 }]
};

var C_TAPPED = 'footswitch_c_tapped';
var ALONE_TIMEOUT_MS = 1000;   // max hold for a b/c press to still count as a tap
var DOUBLE_TAP_MS = 250;       // window for c's double tap (also enter's delay)

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
    description: 'FootSwitch: a=tab, b=dictation/hold cmd, c=enter/double-tap space/hold shift',
    description_notes: [
      '- hold b + tap a: cmd-tab (repeat a to cycle)',
      '- hold b+c + tap a: cmd-shift-tab (reverse)',
      '- double-tap c: space'
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

      // c, second tap within window: space
      pedal('c', {
        to: [
          { key_code: 'spacebar' },
          { set_variable: { name: C_TAPPED, value: 0 } }
        ],
        conditions: [DEVICE, { type: 'variable_if', name: C_TAPPED, value: 1 }]
      }),

      // c, first press: shift while held; return if nothing follows
      pedal('c', {
        to: [
          { set_variable: { name: C_TAPPED, value: 1 } },
          { key_code: 'left_shift', lazy: true }
        ],
        to_delayed_action: {
          to_if_invoked: [
            { set_variable: { name: C_TAPPED, value: 0 } },
            { key_code: 'return_or_enter' }
          ],
          to_if_canceled: [{ set_variable: { name: C_TAPPED, value: 0 } }]
        },
        parameters: { 'basic.to_delayed_action_delay_milliseconds': DOUBLE_TAP_MS }
      })
    ]
  };
}

main()
