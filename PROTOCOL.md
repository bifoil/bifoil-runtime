# Bifoil instruction interfaces

The compiler currently emits the development `bifoil-vm.v3` profile. The runtime retains v1/v2 execution for original
regression fixtures and compatible compiled programs. Full language conformance remains unfinished.

The [compatibility and producer contract](../bifoil-language/compatibility-contract.md) defines the exact supported
format/profile pairs, cache versus module-producer identity, package build identities, and rejection order. Program v1
requires profile v1; program v2 supports profile v2 or v3. Checkpoint v2 envelopes retain the exact program profile;
checkpoint v1 envelopes remain limited to profile v1 and the same compiled build.

## Development profile v3

Module and program formats use `bifoil.module.v6` and `bifoil.program.v2`. The surrounding digest, dependency, function,
and source-span conventions are retained. Modules and linked programs additionally contain nominal `types` definitions,
with parameters, ordered field names, field types/mutability/visibility, method signatures, parent types, and closed
variants.

Cyclic v3 modules optionally carry `group: {members, digest}`. Members are sorted module names for the whole import
component. Internal dependency values use that group digest; external imports retain individual module digests. The
compiler checks every member's ordinary digest and recomputes the normalized group fingerprint before reuse. For that
fingerprint, each member temporarily clears its own digest, group descriptor, and internal import hashes; the final
fingerprint hashes the sorted name-to-member-hash map. Mixed group revisions require recompilation. Acyclic modules
retain their previous encoding.

Module v4 requires ordered operand checks, integer membership checking, and progression-view lowering. Earlier module
artifacts must be regenerated from source; linking an earlier lowered body cannot establish those checks. This changes
compiler artifact compatibility, while retaining the module container structure. Profile v3 additionally requires
declared comparison views for exact equality. Canonical hashing and bounded atomic JSON writes still stream through
writers rather than materializing a complete serialized copy.

Export interfaces include functions, overload sets, globals, nominal types with any generated constructor, and
transparent aliases. A single function uses the existing `function` export tag; a set uses `functions` with a
`signatures` array. Nominal `methods` map member names to signature arrays. Each overload has a distinct function ID.

New compiler output records a Boolean `local` on each function. Local closures bind their distinct IDs in captured
environments; other functions resolve as immutable virtual root bindings without allocating a cell per declaration.
Older checkpoints containing explicit root function cells remain readable. A `member` instruction may carry a selected
`function` ID so the runtime binds the already-resolved method. Built-in method IDs use the $builtin. prefix. Older
runtime fixtures without these fields retain their original single-method and function-scope behavior. Rebuild
precompiled v2 development artifacts after this interface change.

A `function_value` instruction may carry a `captures` array of distinct runtime binding names. New producers emit the
local bindings actually referenced by an anonymous function. The runtime creates an environment containing those same
cell references with the shared root as parent; it does not read their values or copy their contents. An empty array
uses the root directly. Older instructions without this field retain their enclosing environment.

Named local `closure` instructions may carry the same optional `captures` field. The runtime initially retains the
current environment because captured variable declarations may not have executed yet. The collector trims it only when
every required cell is available; it retains cell references without reading uninitialized values. Recursive groups
remain connected through their function cells. Multiple sites for one target must describe consistent capture lists. A
fully prepared checkpoint triggers collection before serialization. Cell/environment IDs are internal graph positions
and may change during collection; their references, aliases, and delayed initialization state remain consistent.

Named generic closures retain their own type parameters as symbolic templates while resolving enclosing parameters. A
`specialize` instruction supplies the declaration's concrete arguments before invocation. Templates and enclosing
arguments survive checkpoints; declaring a generic function does not require prematurely choosing its arguments.

Shared definitions record ty, mutable, initializer, source order, and conservative dependency IDs. A linked program
carries shared_order, listing every shared binding once after its dependencies. The runtime installs empty root cells,
executes that plan before the entry scene, and rejects missing, duplicate, or unordered entries. Module bootstrap IDs
remain in init metadata; programs with shared_order use the binding plan for startup. A load/store never invokes an
initializer. Rebuild older v2 development artifacts that lack this metadata.

Function signatures may carry generic parameters/bounds and a last `vararg` parameter. Type encodings add Char, Null,
Nothing, Any, nullable wrappers, named type arguments, parameters, projections, typed scenes, and variadic function
types. Aliases expand to existing types.

A parameter type may carry `nonnull: true` after a static null check or assertion. The absent/default value is false.
This preserves the parameter's identity while excluding null; it is distinct from an unrefined parameter during static
comparison. Runtime substitution first resolves the argument and then removes nullable wrappers, mapping a null-only
argument to Nothing. Adding a nullable wrapper erases the refinement. Producers and consumers must preserve this marker
in inferred callable interfaces and reify it before installing local/checkpoint types.

Instruction families extend v1 with checked conversions and null operations; member/index/address operations; collection
construction with early duplicate-key checks; ranges and snapshot traversal; lexical/prose unwinding; uninitialized
cells; scene calls/transfers; once-history checks; anonymous function values; generic specialization; and nominal
construction. `src/program.mjs` lists accepted opcodes, while the compiler's `src/model.rs` defines their serialized
fields. Producers and consumers must be updated together.

`unreachable` terminates a path proven impossible by static coverage and reports a checked failure if reached.
`stack_mark {id}` records the operand depth at loop entry; `stack_reset {id}` drops partial operands and nested marks
before a break or continue; `stack_end {id}` removes the completed loop's mark. Scope and prose unwinding remain
separate. These operations preserve operands from an expression surrounding the loop.

Collection copies resolve direct `*` arguments from their source. Nested projections may retain concrete arguments
through covariant result positions, including nullable, nominal, and function-type layers. Invariant slots retain their
requested nested types: a fresh `MutableList<List<*>>` accepts both `List<Int>` and `List<String>` elements. Explicitly
requested scalar conversions still determine converted contents and types. These rules apply to implicit conversions,
copy methods, and empty collections.

Runtime values use explicit heap references for containers, entries, and nominal instances. Cells retain mutability and
initialization state. Functions retain lexical environments, any bound receiver, and resolved type arguments.

V2 checkpoints preserve objects, traversals, loop operand marks, reified arguments, prose buffers, and once-history
alongside the complete suspended frame/cell/environment graph. Saves remain restricted to fully prepared input waits
from the same build. `src/validation.mjs` defines serialization and validation; [ARCHITECTURE.md](ARCHITECTURE.md)
explains ownership.

Restored nominal fields retain their complete declared field set, substituted types, mutability, initialization, and
variant tags. Collection/entry storage must match its type arguments; primitive metadata cannot change a value's kind.
Validation checks referenced cells without recursively expanding cyclic object graphs.

Retained function and scene descriptors must agree with their compiled target and generic arguments. An exposed function
view may widen through the selected subtype/variance rules; it cannot introduce a value conversion or replace the
target's result type. Runtime type tests and casts use the reified target identity rather than its broader exposed view.
Bound method arguments and intrinsic effects survive that view and checkpoint restoration. Unspecialized local templates
retain their own parameters. Active frames require resolved generic arguments and parameter cells with the declared
substituted types and mutability, including immutable vararg Lists. A default expression may suspend before its omitted
parameter has been installed.

V2 String iterators store `{kind: "string", text, offset}` with a UTF-16 offset at a Unicode scalar boundary. This
cursor avoids a per-character snapshot array and preserves traversal progress. V1 fixture traversal encoding is
retained. A failed machine carries `failed: true`; it cannot be checkpointed or restored for continued execution.

The host-facing execution result may be `running` when an instruction quantum expires. Frames, operands, and output
retain their ordinary evaluation order; hosts schedule another run. Only a fully prepared input wait is saveable.

## Code package extension

Eager `bifoil.package.v1` remains a compatibility output layout for the supported v2/v3 profiles. Independently compiled
module artifacts keep their `bifoil.module.v6` representation. A package root carries the ordinary linked-program
metadata, an empty `functions` object, and `chunks`, keyed by module name:

```json
{"scene": "bifoil_code_<sha256>", "module_digest": "<module identity>"}
```

Each `module_digest` equals the corresponding root `modules` value. Every module has exactly one chunk. The current
inventory guard is 1,024 modules. A code scene contains one `*bifoil_module` command whose compact JSON has `format:
"bifoil.code.v1"`, the exact instruction profile of its root, its dotted `module`, and its `functions` map. Its exact
UTF-8 JSON payload bytes, excluding the command prefix and surrounding scene text, determine the lowercase SHA-256
filename. Consumers hash those bytes directly; parsing and reserializing can change Float spellings and is not
equivalent.

The generated scene ends with `*return`. The root calls each code scene using `*gosub_scene`, then executes one
`*bifoil` command with its manifest. The adapter stages chunks in a WeakMap owned by that story's stats object and
consumes them during asynchronous verification. Checksum, module ownership, duplicate function, profile, and ordinary
program validation all finish before VM startup. Node and custom hosts can read the same scenes directly without
executing the native loading prelude.

Chunk identity excludes dependency digests; root metadata retains them. The package build identity is the canonical
manifest hash with an empty `build`, including its chunk inventory. It differs from the corresponding inline build,
which prevents cross-layout save restoration. Immutable chunks publish first and the root publishes last. Existing
chunks may remain for older roots or concurrent builds; directory contents are not the selected package inventory.

The loader assembles a normal `bifoil.program.v2` view with the package build identity. It reads chunks sequentially and
verifies all referenced code. A code module permits at most 16,384 functions and 100,000 instructions; the program
permits 81,920 functions and 500,000 instructions. Programs above 16,384 functions or 100,000 aggregate instructions
require the expanded runtime capacity. Filesystem scene inputs are bounded at 16 MiB of UTF-8 bytes and decoded
incrementally; portable in-memory inputs retain their string-size guard. This is an eager loader and does not establish
the eventual large-project capacity.

### On-demand package v2

`bifoil.package.v2` supports v2/v3 instruction profiles and v1 code chunks, with a root `function_headers` map in
addition to `chunks`. The root has one `*bifoil` command and no eager native scene calls. Headers retain checked
signatures, owning modules, init/local flags, body lengths, continuation positions, and named capture sites. Metadata
remains resident; bodies are fetched and verified on demand and may be evicted.

Every fetched module must exactly match its declared header inventory before any of its code executes. Unused modules
are not read. An evicted body is read and checked again before execution resumes at the saved PC. The default cache is
four modules and 32 MiB of JSON payload weight; one current body is additionally retained per VM. This cache policy is
distinct from physical memory measurement and target-scale acceptance.

`VM.run()` adds a non-saveable `loading` result containing `ready` and completed output. Await `ready` and run again, or
use `VM.runAsync()` to handle code waits through the next ordinary execution result. Code waits preserve operands,
frames, partial calls, defaults, and source diagnostics. A failure remains terminal and leaves earlier output drainable
once. Neither code waits nor ordinary quantum yields are player-input checkpoints.

Restore checks PCs, loop marks, prepared choices, native continuations, and captured identities against the header
metadata. It does not need to fetch all active callers. Bodies and cache state are excluded from saves, and completed
evaluation is never replayed. Build identity includes the complete header/chunk inventory; cross-build/layout restores
remain invalid. An older runtime must reject a v2 package it cannot support. Module artifacts remain v3.

[On-demand compiled code](LAZY_PACKAGES.md) defines the complete header schema, verification order, transports,
lifetime, and host API. Eager v1 and inline compatibility remain independently validated.

## Typed legacy extension in v2

`legacy_globals` maps qualified names to `{ty, mutable, target}`. The root environment installs volatile external proxy
cells rather than caching native values. Module artifacts retain these interfaces for source-free clients.
`legacy_sources` on linked programs maps canonical scene names to unchanged UTF-8 source text.

`legacy_call {target, arguments}` runs inside its generated typed wrapper. The target has `scene`, nullable `label`,
nullable `result`, and optional `transfer: true`. Parameters have already followed ordinary defaults/conversion rules; a
variadic tail is flattened into native arguments. Primitive values, plain enums, and nullable forms are checked. A
result binding supplies the checked return after native `*return`; Unit ignores the external return value.

A plain enum has no type parameters, fields, or nominal parent. Its native representation is the exact declared
case-name String, without the qualified type prefix. Decoding checks that name against the expected enum definition
before allocating a typed enum value. Encoding also checks the value's actual nominal identity. Nullable enum interfaces
preserve native null. Saved native Strings and typed Bifoil enum objects retain their existing graph representations; no
protocol opcode or wire-format change is needed. Other composite boundary values remain unsupported.

Host `start(request)` receives `{target, suspend, args}`. `resume(request, continuation, response)` resumes a prepared
wait. Replies are `{status: "returned", value, output?}`, `{status: "transferred", output?}`, or `{status: "waiting",
options, continuation, input?, output?}`. A transfer target requires a suspending Nothing wrapper; entering it abandons
typed callers, and only a transfer reply can complete it. Ordinary wrappers cannot transfer.

The built-in native host accepts an optional `publishOutput(paragraphs)` construction hook. Published paragraphs are
transferred immediately and omitted from later reply output. An empty array marks a native rendering boundary, such as
an image/chart or a direct line break, rather than an empty paragraph. Empty native returns never publish a boundary.
The browser adapter flushes prior VM prose/output, records native paragraphs in the transcript, and presents them before
the engine-owned renderer continues. Custom `legacy(scene, program, options)` factories can forward this publisher to
`createChoiceScriptHost`. With no publisher, native replies retain their existing buffered output behavior. Callbacks
are recreated on restoration and never enter serialized continuations.

Options carry checked `{label, enabled}` snapshots. Text/number input has no options and carries a checked `input`
descriptor; submitted responses are strings. Invalid input returns another wait with feedback and unchanged prepared
bounds. Ordinary ChoiceScript parsing, expression evaluation, and command execution remain in the supplied engine.

An optional `cancel()` releases host-owned active bridge continuations after terminal failure. It must preserve prior
external side effects and must not replace the original diagnostic.

The host's `snapshot/restore` preserve external state as explicit plain data. Native state uses a separate graph
encoding for references, aliases/cycles, undefined values, and special numbers. Checkpoints keep this host snapshot and
any active native continuation alongside the Bifoil graph. Checkpoint validation precedes host restoration. When a
native host is supplied and the program declares native globals or calls, its state is included even before the first
native access. Snapshotting does not execute a bridge or read a declared native variable; loading restores the snapshot
before later native access. Hostless programs with unused interfaces retain their existing checkpoint behavior.

## V1 compatibility profile

The following section records the original representation and execution behavior. The current runtime retains its
program/checkpoint reader paths; the current compiler requires module v6 and rejects original module artifacts. New
source compilation targets profile v3. This historical section does not override the supported combination matrix.

This document describes the implemented compiler/runtime boundary for `bifoil-vm.v1`. It is a restricted implementation
profile, not a replacement for the full Bifoil language design. Breaking changes require a new profile/version.

## Compilation artifacts

A reusable module is UTF-8 JSON with `format: "bifoil.module.v1"`, `profile`, dotted `name`, `digest`, `dependencies`,
`exports`, `functions`, and optional `init`.

Exports are tagged `function` or `global`. Function exports carry their complete signature: qualified `id`, ordered
parameters (`name`, `ty`, `mutable`, `default`), `result`, `suspend`, and `scene`. Global exports carry `id`, `ty`, and
`mutable`. Default availability is interface metadata; executable default code remains in the compiled function body.

Dependencies map module names to module digests. The compiler reads and validates dependencies even when their original
source is unavailable. A changed digest requires recompilation of the importing artifact. Module initializers execute in
dependency order once before the entry scene.

The digest is SHA-256 over the compiler's compact serde JSON serialization with the digest field set to an empty string.
Maps use lexical key order and struct fields follow their declared order. The artifact is compiler-produced data;
arbitrary JSON reformatting must not be used to recompute its digest. The compiler deserializes and reserializes before
checking, so whitespace changes alone do not invalidate it. This checksum is not a publisher signature.

A linked program has `format: "bifoil.program.v1"`, `profile`, `build`, qualified `entry`, a `modules` digest map,
merged `functions`, and dependency-ordered `init` function IDs. Its build hash uses the same procedure with `build`
empty. A changed module body, constant, signature, dependency, source span, or profile therefore changes the build
identity.

The compiler embeds the linked program in this explicit ChoiceScript extension command:

```text
*comment Bifoil AOT output; requires bifoil-vm.v1
*bifoil {"format":"bifoil.program.v1",...}
```

The JSON contains lowered instructions and type metadata, not Bifoil source for runtime compilation. There is no
implicit dependency on a neighboring checkout. The runtime accepts trusted compiler output with the selected profile; it
validates structure but does not independently authenticate/recompute the build hash.

## Types and values

Types are objects tagged by `kind`: `int`, `float`, `boolean`, `string`, `unit`, or `function`. A function type
additionally contains ordered `params`, `result`, and `suspend`. Ordinary functions may satisfy an otherwise identical
suspend type. The slice does not yet implement general function variance or other full-language types.

Primitive runtime values have `kind` and `value`. Function values instead have `kind: "function"`, function `id`, and
captured `env` ID. Int is signed 32-bit; Float is finite binary64. Widening Int to Float changes the value's tag.
Ordinary equality permits the supported compatible primitives; exact equality compares primitive tags and values.

Each function contains `signature`, `code`, and `init`. Every instruction has `op` and `span: {file, line}`; files are
logical `src/` paths, and lines are one-based. The supported operations are:

| Operations                                  | Behavior                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `constant {ty,value}`                       | Push a typed primitive value.                                            |
| `load {name}`                               | Read the cell resolved through the current lexical environment.          |
| `declare {name,ty,mutable}`                 | Pop a value into a new cell in the current environment.                  |
| `store {name}`                              | Pop and assign an existing mutable cell.                                 |
| `closure {name,function}`                   | Bind a local function capturing the current environment by reference.    |
| `pop`, `dup`, `widen`                       | Discard, duplicate, or convert an Int operand to Float.                  |
| `unary {operator}`, `binary {operator}`     | Apply checked primitive operations to stack operands.                    |
| `jump {target}`                             | Set the current instruction index.                                       |
| `jump_false {target}`, `jump_true {target}` | Pop a Boolean and branch when it matches.                                |
| `enter`, `exit`                             | Enter or leave a lexical environment.                                    |
| `default {name,target}`                     | Skip a parameter's default code when the caller supplied that parameter. |
| `call {names,direct}`                       | Pop arguments and callable, then push a fresh call frame.                |
| `return`                                    | Pop a result, remove the frame, and deliver the result to its caller.    |
| `format {count}`                            | Render and join that many primitive operands in source order.            |
| `print`                                     | Pop one already formatted prose paragraph.                               |
| `begin_choice`                              | Start a fresh option-preparation snapshot.                               |
| `offer {target}`                            | Pop a String label and Boolean enabling value into the snapshot.         |
| `choose {fallback}`                         | Wait for selection, or branch/fail when no option is selectable.         |

The callable is evaluated before supplied arguments. Supplied arguments are evaluated and converted left to right;
omitted defaults execute afterward in parameter order. A direct declared-name call may use names/defaults. A
function-value call supplies every argument positionally. The caller's operand stack remains intact while the callee
runs, including across suspension. Short-circuit operations use branches, not eager binary instructions.

Option preparation evaluates visibility first, then enabling and label for visible options in source order. The
generated branches skip hidden labels. Selection jumps into the chosen body; completed bodies join after the choice.
Enabling/labels cannot suspend. Choice fallbacks are last and unique in this profile.

## Checkpoints

A checkpoint is UTF-8 JSON with `format: "bifoil.checkpoint.v1"`, `profile`, `build`, `cells`, `envs`, `frames`, `boot`,
`pending`, `done`, and `transcript`. Saving is supported only at a fully prepared choice wait.

Cells carry `ty`, `mutable`, and `value`. Environments carry `parent` and a name-to-cell-ID `bindings` map. ID zero is
the root environment; new environments refer to earlier parents. Distinct closures sharing a cell retain the same ID.

Each frame retains its function ID, next `pc`, current `env`, operand `stack`, and prepared `choice` entries. Pending
input identifies the waiting frame and its snapshotted labels, enabling values, and body targets. Boot retains any
not-yet-run initializers/entry. The transcript is presentation history; restoring does not emit it as newly executed
output.

Float negative zero is encoded as `{"kind":"float","value":"-0"}` in checkpoint JSON and restored to binary64 negative
zero. Other Float values remain finite JSON numbers. Int zero has no sign.

Restoration checks format/profile/build, heap references, cell values and types, active instruction indices, and the
prepared choice. Stored set elements and map keys must retain immutable equality-supporting graphs and be unique under
ordinary equality. Mutable descendants and callable keys are rejected, while immutable cycles remain valid. Validation
finishes before restoring host state or releasing a prior owned continuation. Execution resumes from retained
instructions and operands without rerunning completed expressions or option preparation. The current runtime traces and
compacts unreachable heap graphs. Save migration across builds remains unimplemented.

## Initial acceptance coverage

The original compiled fixtures exercise source-free module linkage, named/default interfaces, partial expressions,
shared mutable captures, choice snapshots, escaping function references, checked numeric failures, and source spans. The
optional engine test uses the unmodified pinned dispatcher. It is separate from full browser save-host validation.


## V3 exact comparison instructions

exact_compare carries left_type, right_type, and negate. Types use the ordinary serialized type grammar; negate is a
required Boolean. Pop the right operand, then the left. Resolve both views using the active frame's retained generic
arguments, compare without scalar widening or container copying, and push one Boolean, negated when requested. The
compiler captures each static operand view at its evaluation point, preserving left-to-right flow checks.

Nullable wrappers do not distinguish present values; two nulls compare equal. Primitive kinds remain exact. Composite
comparison views must match, then their declared fields/elements/entries supply child views. Different active sealed
variants remain unequal. Unknown positions retain actual value identities rather than making unlike primitive kinds
equal. Static equality eligibility remains a producer obligation.

The traversal owns iterative frames and a rollback trail for unordered candidates. Pair memoization includes the
comparison view: a proof through a broad covariant view cannot discharge a later comparison through a hidden view. No
operand or heap object is rewritten. Views in reloaded code and generic frame arguments preserve this behavior after
suspension and same-build restoration without replay. Program/profile v1/v2 bodies retain their prior binary
exact-equality instructions; profile v3 requires exact_compare instead.


## Prose contexts and explicit line breaks

Prose-mode callable bodies use existing prose_start/prose_end instructions and return unwinding to own their output.
Their text remains valid after escaping its defining narrative or suspending at input. VM transcripts and custom print
hooks retain real newlines. Default presentation maps LF, CRLF, and CR to visible inline native line breaks without
native variable interpolation. These repairs require no instruction/container version change.

## Typed text admission

The development runtime limits a typed String or assembled text result to 16,777,216 UTF-16 storage units. This is a
runtime admission guard; String operations retain scalar-based language indexes. Size checks precede external scalar
scans and combined-result joins. Invalid scalar diagnostics identify scalar and storage positions without rejected
contents. Typed legacy reads, host output/labels/feedback, submitted text, and restored presentation text are checked.
Invalid submitted text leaves its prepared input wait reusable and does not call the native host. Invalid host output
is terminal while preserving earlier completed output once. These checks do not constrain allocations already made by
an external host or establish aggregate compiler/runtime capacity.
[Text semantics](../bifoil-language/text-semantics.md)
and [admission tests](test/text-admission.test.mjs) record the complete boundary.

The complete current [v3 instruction contract](INSTRUCTIONS.md) specifies every opcode payload, typed operand shape,
source span, state effect, transfer, and suspension obligation. Historical v1 tables remain unchanged.

## Generic producer obligation in module v6

Reusable modules now require v6: preserve supplied, bound-valid generic arguments when their result already satisfies
the expected type by genuine subtyping. Context may fill missing arguments before that proof. Earlier module bodies
can retain different construction identities, so consumers require source regeneration rather than relabeling. The
instruction profile remains v3; no runtime opcode, program, package, code-chunk, or checkpoint schema changes.
The [compatibility contract](../bifoil-language/compatibility-contract.md#retained-generic-inference-in-module-v6)
defines the producer boundary.
