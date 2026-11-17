# On-demand compiled code

`bifoil.package.v2` separates a program's checked declaration/continuation metadata from its instruction bodies. The
compiler still checks and compiles every body ahead of time. The runtime fetches already compiled code when execution
reaches it; it never parses or compiles Bifoil source during play.

## Files and compatibility

The root contains one `*bifoil` command and no eager `*gosub_scene` prelude. It carries the normal v2 program metadata,
an empty `functions` object, `chunks`, and `function_headers`. Each module's chunk reference retains its exact module
digest and content-addressed `bifoil_code_<sha256>` scene name. Code scenes retain `bifoil.code.v1`, so identical
existing chunks remain reusable. Independently compiled artifacts retain `bifoil.module.v5`; the instruction profile
remains `bifoil-vm.v3`.

A function header has `module`, `signature`, `init`, `local`, `instructions`, `continuations`, and `captures`:

- `instructions` is the positive body length, without the body array.
- `continuations` maps decimal instruction positions to the complete compiled `choose`, `legacy_call`, and
  `stack_mark` records at those positions, including their source spans.
- `captures` contains the compiled named `closure` records. Anonymous function values retain their existing explicit
  capture operands in their bodies.

The package build identity includes these headers and chunk references. Inline programs and eager v1 packages retain
their own build identities. A checkpoint from another build/layout is rejected. Older runtimes lacking package v2
support must reject the root; treating an empty function map as an inline program is not a compatibility fallback. The
current runtime also accepts eager `bifoil.package.v1` roots and their existing native scene-registration prelude.

## Validation and fetching

Before creating execution state, validate the complete root inventory, header signatures, module ownership, instruction
budgets, continuation positions, capture targets, legacy interfaces, startup plan, and scene entry. Root metadata
becomes immutable. A private provider registration identifies lazy program views; JSON fields cannot disable ordinary
body validation on inline programs.

Before executing any instruction from a fetched module:

1. Read only its validated sibling scene name, with bounded UTF-8 decoding.
2. Check its code format/profile, module name, and the SHA-256 of the original JSON payload bytes. 3. Require exactly
the function IDs declared for that module. 4. Derive each function's header from its body and compare it structurally
with the root's declared metadata. 5. Validate all instruction envelopes through the same validator used by inline/eager
programs. 6. Publish the complete verified module to the code cache.

An unused module is not fetched merely because its header exists. Damage to unused code is therefore diagnosed on its
first required load. A failed verification publishes none of that module's bodies and permanently fails the requesting
machine. Checksums detect corruption and identity mismatches; they do not authenticate a publisher. Compiled packages
remain trusted build inputs.

## Code residency and lifetime

The default cache retains at most four decoded modules and at most 32 MiB of original JSON payload bytes. Both guards
must hold. `maxResidentModules` and `maxResidentBytes` may override those cache limits with positive safe integers; a
module larger than the selected byte budget fails explicitly. The byte weight is a deterministic cache policy, not a
measurement of JavaScript heap or total physical memory.

Loads are queued across one program provider, with concurrent requests for one module sharing a single fetch and
verification. Resident modules use least-recently-used eviction. Eviction drops their decoded function maps. Loading an
evicted module repeats its read and integrity checks; it cannot silently use changed content under an old filename.
Encoded source text and digest buffers are not retained in the resident cache.

One VM additionally retains its current function body as an execution handle across host yields. Its other frames keep
function IDs, program counters, environments, and operands. Returning to an evicted caller loads its code at that
existing PC; it does not repeat call setup, supplied arguments, defaults, completed expressions, or prior output. The
handle is released on completion or terminal failure. Multiple VMs can share one immutable program/provider while
retaining independent execution states. Cache limits do not claim to bound an arbitrary number of independent VMs.

Metadata remains resident, including signatures and nominal declarations. Current root, module, function, instruction,
heap, and checkpoint admission guards remain in force. This implementation removes eager body residency; it does not
establish tens-of-millions-of-lines capacity, disk-backed declaration indexes, aggregate compiler-memory compliance, or
incremental timing compliance.

## Execution and hosts

`VM.run()` can return `loading` with `ready`, an asynchronous completion promise, and the ordinary completed `output`.
The host must consume that output once, await `ready`, then call `run()` again. A code wait is an implementation wait,
not player input: it has no choices and cannot be saved. Repeated runs during the same fetch reuse its promise.

`await machine.runAsync()` handles code waits until the next ordinary `running`, `waiting`, or `done` result. It retains
the configured instruction quantum. Selection/submission still uses the existing synchronous methods; their results can
likewise contain a code wait. On a failure, previously completed output buffered by `runAsync` remains available once
through `drainOutput()`. The original terminal diagnostic remains authoritative for later operations.

The terminal and conformance executor handle both instruction yields and code waits. A filesystem host can pass cache
options to `readCompiledProgram(path, options)`. A portable host can use `loadCompiledProgram(rootSource, readChunk,
options)` or `loadPackage(manifest, readChunk, options)`. `packageCodeStats(program)` from `src/program-code.mjs`
reports resident module/byte weights, loads, evictions, and pending requests; it does not report physical peak memory.

The ChoiceScript adapter fetches validated code scenes beneath `Scene.baseUrl`, without executing their native commands.
It snapshots that asset origin when opening a package, so later host changes cannot retarget its provider. Its optional
asynchronous `readChunk(scene, sceneName)` hook supports other transports. The browser reader checks reported and
observed byte limits, rejects malformed UTF-8, and releases its stream on failure. Web Crypto or the existing
asynchronous digest hook provides payload hashing.

Code-fetch completions check the adapter's session identity and generation before resuming. Detach, restore,
replacement, and adapter reinstallation cannot let an obsolete completion attach or advance its old machine. A late
failure is reported once through the existing error hook. `scene.bifoilLoading` exposes current package/code loading;
low-level hosts should also handle subsequent waits after selections.

## Checkpoints

Only fully prepared player-input waits are saveable. Checkpoints retain the existing full suspended state and same-build
contract. Function bodies and cache contents are excluded.

Restoration validates saved callable signatures, captured cells, active parameters, PCs, loop marks, choice targets, and
pending typed/native operations against the root's metadata. It need not read a body to validate or redisplay an already
prepared choice. The first subsequent execution fetches the required body normally. Loading a checkpoint does not replay
startup, choice preparation, shared initialization, or any already completed operand.

## Ownership and evidence

[Package parsing](src/package-format.mjs) owns shared format/integrity checks; [lazy providers](src/lazy-packages.mjs)
own verified publication, request coalescing, and eviction. [Private code views](src/program-code.mjs) give execution,
collectors, and restore validation one metadata interface. [Header derivation](src/code-metadata.mjs) and [instruction
validation](src/program-instructions.mjs) keep eager and lazy contracts aligned. The compiler's [streaming metadata
scanner](../bifoil-compiler/src/code_store/runtime_header.rs) keeps ordinary body payloads out of the root and does not
allocate a complete decoded instruction vector.

[Runtime controls](test/lazy-packages.test.mjs) cover cold/unused modules, one-module residency, 300 unused modules,
fresh-host restoration, shared concurrent reads, corruption after eviction, failed output draining, invalid metadata,
prototype-like names, bounded readers, and stale host completions. The [original engine
dispatcher](test/engine.test.mjs) exercises both package versions against the supplied unchanged engine. The [deep
source-free case](../bifoil-language/conformance/cases/lazy-package-deep-source-free-checkpoint/main.bfl) preserves
seven active frames and earlier expression operands while their caller modules are evicted and restored. The [browser
acceptance procedure](BROWSER_ACCEPTANCE.md#compiled-package-and-cold-restoration) covers cold package restoration
through the unchanged renderer. Complete-game and target-scale resource acceptance remain separate.
