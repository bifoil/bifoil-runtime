# Bifoil Runtime

The development execution layer for compiled Bifoil programs, maintained by **chinay** for the Bifoil Foundation.

This JavaScript runtime executes versioned instructions through an explicit ChoiceScript extension. The current
development profile is `bifoil-vm.v3`; original v1 and v2 regression fixtures remain supported. It executes compiled
instructions and does not parse Bifoil source.

Full language conformance, complete browser/save-host acceptance, and releases remain unfinished. See the
[implementation status](../bifoil-language/implementation-status.md) for current evidence and remaining work.

## Test independently

With Node.js 24 or newer:

```sh
node --test test/*.test.mjs
```

No package installation, adjacent checkout, private corpus, or compiler executable is required. Tests use original
generated protocol fixtures. An optional acceptance test reads an explicitly supplied, unmodified ChoiceScript engine:

```sh
CHOICESCRIPT_ENGINE=/absolute/path/to/choicescript/web/scene.js node --test test/engine.test.mjs
```

Without that variable the engine test is skipped. The tested baseline is upstream commit
`60a6c3ee7393c9ee7e42650b8e1642ae38e3cb6a`. Its real command dispatcher runs the extension; 20,000 fairmath results are
compared against the engine's operators. This does not establish full browser/save-host acceptance.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for module responsibilities, runtime state, and maintenance guidance. Formatting
uses the checked-in 120-column Prettier configuration with other defaults.

Read the [compatibility contract](../bifoil-language/compatibility-contract.md) for supported version pairs and
producer requirements. A valid format name and a valid profile name cannot be combined arbitrarily. Original v1
programs remain readable and receive v2 checkpoint envelopes that retain their original execution profile.

## Execute compiler output

Obtain `startup.txt` from a compiler supporting the [instruction interface](PROTOCOL.md):

```sh
node src/cli.mjs startup.txt
node src/cli.mjs startup.txt --save checkpoint.json
node src/cli.mjs startup.txt --load checkpoint.json
```

Saving stops at the first fully prepared input wait. Loading requires the same compiled build and does not replay
earlier evaluation or output. A retained transcript is available for hosts that deliberately choose to display it.

## Compiled code packages

The terminal recognizes on-demand `bifoil.package.v2` roots and eager v1 compatibility roots. Keep every named
content-addressed code scene beside `startup.txt`. Version 2 starts from checked declaration/continuation metadata and
fetches instruction bodies when execution reaches them. Its default cache retains at most four modules and 32 MiB of
JSON payload weight, with a separate current-function handle per VM. Evicted callers resume at their retained PCs.

Filesystem and browser transports enforce a 16 MiB scene byte limit and reject malformed UTF-8. Every fetched module's
raw JSON hash, ownership, signatures, continuation/capture summaries, and instructions are checked before its code
executes. Unused code is not fetched. Packages remain trusted compiler output; hashes establish integrity rather than
publisher authentication.

For a custom loader, use `loadCompiledProgram(rootSource, readChunk, options)` from `src/packages.mjs`. Low-level
`VM.run()` may return `loading` with a `ready` promise; await it before running again. `VM.runAsync()` handles these
code waits until the next instruction yield, prepared player-input wait, or completion. Only prepared input is saveable.
The terminal, conformance executor, and ChoiceScript adapter handle code waits directly.

The ChoiceScript adapter reads v2 code beneath `Scene.baseUrl`, or through an asynchronous `readChunk(scene, name)`
hook.
Browser hashing uses Web Crypto or the existing digest hook. Old v1 roots still use `*gosub_scene` and `*bifoil_module`
registration. Obsolete asynchronous completions cannot resume detached or replaced sessions.

See [on-demand compiled code](LAZY_PACKAGES.md) for versioning, cache options, host APIs, restoration, and evidence.
Metadata and the existing admission guards remain resident; this does not establish target-scale source capacity or
strict compiler resource compliance.

## Execution state

The VM uses explicit call frames, operand stacks, lexical environments, binding cells, heap objects, and traversal
snapshots. These preserve shared captures, mutable aliases, bound receivers, reified type arguments, partially evaluated
expressions, prose scopes, option snapshots, and once-selection history across supported checkpoints.

Primitive operations share one set of value constructors and checks. Structural equality uses an explicit work stack for
deep and cyclic object graphs. Failed unordered-match candidates roll back their comparison assumptions. Calls preserve
compiler-selected evaluation and conversion order; omitted defaults execute in the callee, and varargs receive a fresh
immutable list. Overloaded methods bind the compiler-selected function ID and capture their receiver once. Generated
copies preserve the statically requested generic result type.

Shared initialization follows the compiled dependency plan and completes before scene execution. Reads and writes never
start another initializer. Startup metadata and checkpoints reject incomplete initialization. A tracing collector
reclaims unreachable cells, environments, and objects at instruction boundaries while preserving aliases, cycles, active
operands, bound receivers, and traversal snapshots.

Collection conversions and explicit copies share an iterative evaluator; they preserve projected identities and shallow
aliases without expanding container depth onto the host call stack. See [value operation controls](VALUE_OPERATIONS.md).
Independent [runtime capacity controls](CAPACITY_TESTS.md) exercise active allocation, call-depth boundaries,
long execution, collector pressure, and large checkpoints separately from compiler source-volume workloads.

These are implemented paths with regression coverage. They do not establish complete type-system or steering
conformance. The development compiler's limitations still apply.

## ChoiceScript host integration

Import `installChoiceScript` from `src/choicescript.mjs` and call it with the host's `Scene` constructor before
executing compiled scenes. It registers the required `*bifoil` and `*bifoil_module` commands against the unmodified
engine.

The adapter stores checkpoint data as a plain string in `scene.stats.bifoil_checkpoint`. The save host must persist and
restore that stat, then call `adapter.restore(scene, program)` to reattach the waiting VM. Same-build validation happens
before execution resumes.

Default presentation uses engine paragraph/output facilities, `printOptions`, and `printInput`. Hosts may supply
`print`, `renderChoice`, `renderInput`, and `finish` hooks. The adapter runs instruction slices of 10,000 by default and
schedules continuations through `setTimeout`; `quantum` and `schedule` hooks customize that policy. Obsolete
continuation callbacks cannot resume a replaced or failed session. Text and labels are already interpolated;
presentation must not apply ChoiceScript variable replacement again. Callbacks from consumed choices are rejected.

The built-in native bridge publishes completed paragraphs before native image/chart rendering and direct line breaks. An
empty native return does not split surrounding Bifoil prose. A custom `legacy(scene, program, options)` factory may
forward `options` to `createChoiceScriptHost`; its optional `publishOutput` hook preserves the same ordering. Published
paragraphs enter the VM transcript and are not emitted again in the native reply. Without a publisher, the native host
retains its buffered reply interface.

The original browser acceptance host saves rendered page history separately from the VM checkpoint. It removes input
controls from that history, validates execution before restoring the page, and rebuilds live controls without replaying
native preparation. Earlier raw-checkpoint saves remain readable. This is an acceptance-host facility; production save
hosts still own persistence, presentation history, and platform integration.


Terminal and dispatcher paths and original browser fixtures are tested. Real Chrome acceptance used the unchanged engine
renderer for disabled choices, literal interpolation, successive inputs, and save/load. A full page reload at a native
fractional-number wait retained the earlier text response and completed preparation exactly once. Consumed forms and
their separate submit buttons were removed, and the final browser console had no errors or warnings. A complete game,
native engine save UI, cross-device storage, and deployment package remain unvalidated.

A reproducible local harness serves only the runtime, original fixtures, and explicitly supplied engine assets:

```sh
node tools/serve-browser.mjs --engine-dir /absolute/path/to/choicescript/web --port 8765
```

Open the printed loopback URL. The toolbar saves prepared checkpoints in local storage; page reload restores the saved
fixture before starting new story execution. This harness does not test a platform's native save UI or billing. Its
fixture sources are original; `tools/regenerate-fixtures.py --help` describes regeneration with an explicit compiler.
Browser evidence belongs under ignored `output/playwright/`.
The [browser acceptance procedure](BROWSER_ACCEPTANCE.md) records fixture assertions, the separate presentation-save
contract, cold package restoration, and evidence requirements.

Real Chrome acceptance for the original native-output fixture verified text/image/chart order using the unchanged engine
and its stylesheet. Saved native and typed input waits retained rendered history across fresh-page reloads while the
preparation counter remained one. Restored controls were rebuilt once; completion retained the exact transcript and left
no game forms or buttons. The browser console had no errors or warnings, and the checked runtime, stylesheet, fixture,
and image requests succeeded. These checks cover the original acceptance host rather than production save services or
complete games.

To exercise an actual compiler package, pass `--package-dir /absolute/path/to/generated/scenes`. The harness adds a
package fixture and serves only `startup.txt` and correctly named code scenes from that directory. Real Chrome
acceptance checked native scene requests, a second-choice checkpoint, and full-page restoration with preparation still
executed once. Completion removed the consumed choice and left no browser errors or warnings.

When a host replaces a scene outside `adapter.restore`, call `adapter.detach(scene)` first. Detachment cancels only the
session's owned native continuation; it preserves the serialized checkpoint stat. Old callbacks and session handles
cannot resume replaced execution.

## Typed legacy hosts

Compiled legacy interfaces require a host implementing `read`, `write`, `start`, `resume`, `snapshot`, and `restore`.
The built-in ChoiceScript adapter uses the supplied unchanged engine and embedded original native sources. Ordinary
bridges must return; explicit transfer bridges abandon Bifoil callers and may transfer/end natively. Primitive values,
plain enums, and nullable forms are checked at every boundary, without accepting a numeric String as an Int or Float.
Plain enums use their exact declared case-name Strings in native code. The expected nominal enum type determines the
allowed names; other data instances and generic enum interfaces are rejected.

Native choices, page breaks, text input, and number input produce prepared waits. `VM.choose(index)` handles options;
`VM.submit(text)` handles text/number input. Invalid user input retains the prepared wait and returns feedback.
Checkpoints preserve native temporary/call/statistic/navigation graphs alongside Bifoil state, including aliases,
cycles, and special native numbers. Completed preparation is not repeated after loading into a fresh engine host.

The terminal host accepts an explicit engine path and optional JSON initial statistics:

```sh
node src/cli.mjs startup.txt --engine /path/to/choicescript/web/scene.js --legacy-stats initial.json
```

`test/legacy-engine.test.mjs` uses `CHOICESCRIPT_ENGINE` for fresh-host restoration and a differential comparison with
the original number-input callback. These tests do not establish support for every native UI/platform command.

## Limits and boundaries

Failures report original Bifoil source spans. Checks cover integer overflow, finite Float results, division by zero,
Boolean conditions, relevant type/conversion rules, indexing, casts, effects, and choice validity. Fairmath retains the
pinned engine's operation order, rounding, zero-modifier behavior, and clamps.

The development runtime guards call depth at 1,024 and heap cells/environments/objects at 100,000 each. Checkpoints are
limited to 16 MiB. A tracing collector runs when allocation thresholds are reached; exhausting a guard after collection
fails the story. These runtime guards are separate from compiler budgets and do not demonstrate the source-capacity
target.

`VM.run()` executes at most its configured instruction quantum, defaulting to 1,000,000, and returns `running`,
`waiting`, or `done`. A `running` result retains progress for another call; it is not a runtime failure or a save point.
The terminal yields between slices. Individual built-ins and native bridge execution remain synchronous; native bridge
execution retains its separate 1,000,000-command guard. Slicing is not wall-clock preemption.

Checked execution failures stop the machine permanently. Later run, selection, submission, and save requests retain the
original source diagnostic. Hosts can drain output completed before the failure through `drainOutput()`; the provided
adapters deliver it once before reporting the error. Invalid player input or an invalid host selection leaves a prepared
wait available for correction.

Scalar String operations scan the original string without constructing a full character array. V2 traversal retains a
validated UTF-16 cursor at a scalar boundary, including across collection and checkpoints. Large argument and output
groups are appended iteratively to avoid the JavaScript engine's function-argument limit.

Checkpoints are validated for profile/build, types, references, frames, traversals, and prepared choices. They are not
authenticated and are not a security boundary against untrusted compiled code or deliberately forged saves.

No ChoiceScript engine source is vendored, modified, or relicensed here. Bifoil is independent of Choice of Games and
upstream ChoiceScript. No release, remote, or license selection is established by this work.

## Sonar analysis

The Sonar workflow requires at least **80% coverage in every production source file**, using covered executable lines
and condition outcomes from the configured reports. The comparison uses exact counts; project averages and rounded
percentages cannot hide a failing file. Missing coverage or test evidence fails the check. Files without executable
Sonar coverage locations retain their separately verified compilation or command-test evidence and report `N/A`.
This per-file floor is additional to the 100% overall/new condition requirement and the existing issue-count limits.

[SonarQube Cloud](https://sonarcloud.io/dashboard?id=bifoil_bifoil-runtime) analyzes this public repository.
[Scanner settings](sonar-project.properties) separate original production sources from tests. Run the standard
`sonar-scanner` with `SONAR_TOKEN` supplied through the environment; never save a token in source or command arguments.
Scanner output stays under ignored `.bifoil/development/sonar/`. Use scanner-based analysis with automatic analysis
disabled for this project. A completed analysis and its quality gate are separate from passing local tests.

Generate LCOV before scanning with the built-in Node test runner:

```sh
mkdir -p .bifoil/development/sonar
node --test --experimental-test-coverage --test-coverage-include="src/**" \
  --test-coverage-include="tools/browser-fixtures.mjs" \
  --test-reporter=lcov --test-reporter-destination=.bifoil/development/sonar/runtime.lcov test/*.test.mjs
```

Set `CHOICESCRIPT_ENGINE` explicitly to include the optional unchanged-engine acceptance tests in coverage.

The headless native host loads an explicitly supplied trusted ChoiceScript JavaScript engine and its utility files.
Its VM context isolates engine globals; the caller owns the trust decision for that engine installation. Story prose,
player responses, and checkpoint contents are handled as data. The browser acceptance server serves approved routes
on loopback; its engine and package roots are selected by the operator.

[Text admission](../bifoil-language/text-semantics.md#scalar-validation-and-limits) bounds individual typed Strings and
combined text results in the development runtime, with scalar/storage diagnostics and recoverable input API rejection.
It does not establish aggregate resource or project-scale acceptance.

The [native command inventory](native-command-profile.json) and [legacy compatibility
contract](../bifoil-language/legacy-compatibility.md) enumerate the pinned engine commands and explicit bridge limits.

[Instruction contracts](INSTRUCTIONS.md) enumerate the complete current v3 opcode interface and its typed operands,
state effects, source attribution, and continuation ownership.
