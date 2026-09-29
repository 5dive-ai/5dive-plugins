// DIVE-5166: a lite (partner-client) agent stayed silent for the whole of a
// long request ("make a site with a week calendar": nothing until the file was
// done). LITE_INSTRUCTIONS had dropped the ack-first rule, so this arm pins it
// back in the lite instructions.
//
// DIVE-5166 also gave the silence watchdog a narrow lite arm (one nudge after
// 20s). DIVE-5194 removed it: lite now runs the default watchdog unchanged, and
// test/dive5194-lite-default-hooks.test.ts pins that instead.
import { describe, test, expect } from 'bun:test'
import { LITE_INSTRUCTIONS } from '../plugins/telegram/hooks/lib/lite'

describe('the lite instructions carry the ack-first rule', () => {
  test('a long request gets an "on it" line first and the result as a new message; a quick one gets one reply', () => {
    expect(LITE_INSTRUCTIONS).toContain('first send one short line in your own voice saying you are on it')
    expect(LITE_INSTRUCTIONS).toContain('send the result as a new message')
    expect(LITE_INSTRUCTIONS).toContain('A quick question gets one reply')
    expect(LITE_INSTRUCTIONS).toContain('Never go quiet on a request.')
    // consumer wording: none of the operator ack machinery leaks in
    for (const operator of ['edit_message', '30s', 'progress', '5dive']) expect(LITE_INSTRUCTIONS).not.toContain(operator)
  })
})
