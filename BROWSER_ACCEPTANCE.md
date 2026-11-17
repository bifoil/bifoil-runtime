# Browser acceptance

The original browser host exercises compiled Bifoil execution through the supplied, unchanged ChoiceScript renderer.
It serves original fixtures, runtime modules, and an explicitly supplied engine. It does not modify vendored engine
sources or require an editor extension.

## Run the host

Use Node.js 24 or newer and an unmodified ChoiceScript web directory:

```sh
node tools/serve-browser.mjs --engine-dir /path/to/choicescript/web --port 8765
```

Open the printed loopback URL in an isolated browser profile. The tested engine baseline is commit
`60a6c3ee7393c9ee7e42650b8e1642ae38e3cb6a`. The host sends `Cache-Control: no-store` so a full-page reload reads current
runtime modules. Record the browser/Node versions, engine revision and modifications, and exact input hashes with each
acceptance run.

Choose a fixture in the toolbar. **Restart fixture** begins a new execution of that fixture; it does not erase a saved
checkpoint. **Save checkpoint** stores the current prepared player-input wait for that fixture. **Load checkpoint**
replaces execution with the saved wait. Reloading the entire page restores that fixture's saved wait before starting
new story evaluation. Each fixture has its own storage key in this acceptance profile.

## Host save contract

[Execution checkpoints](src/vm.mjs) preserve VM state and its transcript. The
[presentation envelope](tools/browser-save.mjs) separately preserves the host's rendered page, including native images
and charts. Game forms, buttons, inputs, selects, and textareas are excluded from saved presentation. Restoring first
validates and attaches execution, then restores presentation and rebuilds the one live input. It does not execute story
preparation to reconstruct that input. Earlier raw-checkpoint acceptance saves remain readable without page history.

Test both loading within the current page and restoring into a fresh page. Compare effects, native responses, retained
transcript, DOM order, images/charts, and live controls. Repeated loads must not duplicate historical output or live
forms. Completing the fixture must remove every game form, input, and submit button while retaining earlier narrative.
An invalid proposed execution checkpoint must not replace a working session; adapter/VM lifetime controls also cover
stale callbacks, detachment, and replaced sessions.

The [presentation controls](test/presentation-forms.test.mjs),
[adapter lifetime controls](test/adapter-lifetime.test.mjs), and
[native renderer controls](test/native-output.test.mjs) complement real-browser acceptance. A mocked DOM or engine
command dispatcher alone does not establish browser behavior.

## Typed choices and suspended expressions

1. Restart **Typed choices and suspended expressions**. Confirm that `Unavailable` is disabled and the selectable
   label is exactly `Take 1 and ${literal}`; the literal interpolation marker must not be processed again by the engine.
2. Save, reload the full page, and confirm the same prepared labels and enabled states. The preparation counter remains
   one.
3. Select the available option. The next paragraph must be `First 12; prepared 1.`, followed by a `Finish` choice.
4. Save at this second wait, reload, and load again within the page. The paragraph remains present once and preparation
   remains one.
5. Finish. The retained transcript is `First 12; prepared 1.` followed by `Done.`, and no game controls remain.

## Native text and number input

1. Start **Native text and number input**. Enter `Ada ${literal}` through the engine's text control.
2. At the following fractional-number wait, save and reload the page. The earlier response remains `Ada ${literal}`,
   both input prompts remain in order, and the native preparation counter remains two.
3. Enter `3.25` through the number control. The resulting paragraph is exactly `Ada ${literal}|3.25|2`.
4. Save the following typed wait, load it again, and finish. The retained transcript contains each prompt and result
   once, the counter remains two, and no consumed form or submit button remains.

## Native image and chart ordering

1. Start **Native image and chart ordering**. Verify this rendered order: `Bifoil before.`, `Native before.`, the native
   marker image, `Native between.`, the `Calls: 1%` chart, and `Native after.`.
2. Confirm the marker image has loaded. Save at `Continue native` and reload the page. Compare the DOM sequence,
   loaded image, chart, and text with the saved page; native preparation remains one.
3. Continue. `Native resumed.` must precede `Bifoil after 1.` and the following `Finish` choice.
4. Save, reload, and load within the page. Historical paragraphs, image, chart, and the one live choice remain present
   once. Finish and verify the exact transcript and removal of game controls.

## Compiled package and cold restoration

Add `--package-dir /path/to/generated/scenes` to the host command. The directory must contain `startup.txt` and its
content-addressed code scenes. The toolbar then includes **Compiled code package**.

The [deep source-free case](../bifoil-language/conformance/cases/lazy-package-deep-source-free-checkpoint/main.bfl)
provides a regression project with eight modules, seven active call frames, earlier expression operands, and two input
waits. Its conformance setup independently compiles helpers and removes their sources before compiling the client.
The package exceeds the default four-module code cache, requiring caller reloads during unwinding.

1. At `Resume 6|6`, save and reload. Confirm seven retained frames, the preparation counter at six, and zero code-scene
   requests or resident function bodies before selection. The root alone validates and renders this prepared wait.
2. Continue to `Verify 157|6`. Save and reload again. Confirm one retained frame, the counter still six, and zero
   code-scene requests before selection.
3. Finish. The exact transcript is `157|6`, all frames are unwound, and no game controls remain. Code is fetched only
   when subsequent execution requires it.

[On-demand code controls](test/lazy-packages.test.mjs) additionally cover eviction, repeated integrity checks,
concurrent requests, corrupted modules, bounded readers, detached sessions, and captured asset origins. Browser
restoration and cache residency are separate from compiler-memory or target-scale capacity claims.

## Evidence and support boundary

Retain UI snapshots, screenshots, console observations, network results, checkpoint effects, and before/after input
hashes under ignored `output/playwright/`. Check that engine/runtime/fixture requests succeeded and that the final
browser console has no errors or warnings. Preserve failed observations alongside corrected follow-ups.

This procedure covers the original local-storage acceptance host, supplied engine, and recorded browser platform.
Production save providers, native engine save UI, cross-device persistence, complete-game acceptance, other browsers,
and release/deployment acceptance require their own evidence.
