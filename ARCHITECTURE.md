# Runtime architecture

The runtime executes already compiled instructions. It does not parse Bifoil source or replace the ChoiceScript
interpreter. The ChoiceScript adapter registers an explicit extension against an unmodified engine.

## Compiled package ownership

`src/packages.mjs` owns portable package parsing, chunk checksums, module/function ownership, and assembly into the
ordinary v2 program view. `src/node-program.mjs` restricts filesystem reads to validated sibling scene names and uses
Node's native digest implementation. The CLI and conformance executor share that reader. Files are read through a
bounded buffer and streaming UTF-8 decoder; stat rejects oversized inputs immediately, and byte accounting also detects
growth during reading. Multibyte scalars crossing a buffer boundary retain their original text. Every opened handle
closes on success or failure.

The ChoiceScript adapter stages code text by stats-object identity. Its asynchronous root load installs a placeholder
session; only that same live placeholder may attach the assembled machine or report an error. Replacement, restoration,
and detachment invalidate it. Consumed staged text is released as chunks are decoded, but all code remains resident
before execution. The browser harness exercises both the actual native loading prelude and fresh-page program assembly
for restoration.

## Execution and dependencies

`VM` extends the member and frame layers through ordinary class inheritance. Instruction handlers receive the machine
explicitly. VM behavior is defined by these classes and imported handlers. The separate ChoiceScript adapter registers
the engine's bifoil command.

| Module                     | Responsibility                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `src/vm.mjs`               | Host-facing API, execution loop, primitive stack instructions, choices, and prose scopes.    |
| `src/operations.mjs`       | Heap and story instructions; returns false for instructions handled by the core loop.        |
| `src/members.mjs`          | Field/method lookup, indexing, assignment addresses, and built-in methods.                   |
| `src/frames.mjs`           | Call frames and positional, named, default, and variadic argument binding.                   |
| `src/functions.mjs`        | Virtual immutable root declarations, without per-function heap cells.                        |
| `src/heap.mjs`             | Values, objects, lexical environments, captured cells, conversions, and structural equality. |
| `src/values.mjs`           | Primitive construction, integer/Float checks, rendering, and scalar-string validation.       |
| `src/numeric.mjs`          | Primitive operators, including the pinned ChoiceScript fairmath formulas.                    |
| `src/collection-index.mjs` | Ephemeral primitive-key indexes, with conservative composite candidate buckets.              |
| `src/equality.mjs`         | Iterative ordered/unordered structural comparison with cycle-pair rollback.                  |
| `src/rendering.mjs`        | Iterative explicit String conversion, preserving cycle and repeated-alias behavior.          |
| `src/text.mjs`             | Unicode scalar scanning, indexing, slicing, ordering, and cursor checks.                     |
| `src/errors.mjs`           | Original-source diagnostics, terminal failure state, and owned host cleanup.                 |
| `src/types.mjs`            | Runtime type identity, subtyping, and reified generic substitution.                          |
| `src/program.mjs`          | Compiled-program envelope and instruction validation.                                        |
| `src/validation.mjs`       | Checkpoint parsing, serialization, graph validation, and input-wait checks.                  |
| `src/choicescript.mjs`     | Engine registration, owned session lifecycle, and host save attachment.                      |
| `src/presentation.mjs`     | Default engine presentation and removal of consumed controls.                                |
| `src/cli.mjs`              | Terminal presentation and explicit save/load commands.                                       |

The inheritance chain is `RuntimeHeap` → `RuntimeFrames` → `RuntimeMembers` → `VM`. The classes share one machine state
owned by the VM. Operators and checkpoint validators are imported directly; their dependencies are visible.

## Resuming execution

A frame retains its function, program counter, lexical environment, operand stack, traversal state, and active loop
operand marks. A loop transfer truncates only the abandoned partial expression, preserves surrounding operands, and
removes marks for abandoned nested loops. Checkpoints validate those depths before resuming. Heap references and
captured binding cells preserve sharing. Mutable containers and data instances retain their identity through aliases.

New anonymous functions capture only their referenced local cells, preserving shared mutation and delayed initialization
without retaining unrelated enclosing bindings. Pure/global-only functions use the root environment directly. Named
local functions initially retain their enclosing environment for forward references. During collection,
`src/closure-captures.mjs` resolves complete capture lists to shared cells and trims unrelated bindings, including
mutually recursive function groups. A missing future cell keeps the original scope alive until a later collection. Older
artifacts without capture metadata retain their existing behavior. Generic local function declarations retain their own
parameter templates and close outer arguments before later specialization.

`src/callable-values.mjs` checks retained function/scene identities, environments, argument descriptors, and exposed
signature views. The compiled declaration is reified with retained arguments; its type must safely satisfy any exposed
view through subtyping. This preserves ordinary-to-suspend widening, projected methods, and function variance without
accepting a substituted result type or conversion adapter. Unspecialized local declarations retain their own parameter
templates while closing outer arguments. Intrinsic function types are independently reified from the target and retained
arguments. A broader exposed view never retags that identity, so bound methods retain their actual receiver arguments
through covariance and checkpoints. Ordinary functions likewise retain their intrinsic effect when stored through a
suspend view.

`src/checkpoint-callables.mjs` checks active invocation types after frame references have been validated. Active generic
arguments must be present and well formed. Existing parameter cells retain the invocation's exact substituted types,
mutability, and initialization; varargs use their immutable List wrapper. An omitted default may still be evaluating in
a suspended call before its cell exists.

Nested projected collection copies preserve available concrete arguments through safe covariant views, including
nullable, nominal, and callback layers. Fresh mutable element types and invariant map keys retain their requested nested
projected types so later writes remain valid. Copy methods and implicit conversions share the same reification helper.
Nominal parent views use bounded traversal and report cyclic metadata rather than looping. Generated nominal copies
retain concrete owner arguments for direct stars in the requested result. Explicitly requested arguments, including
nested projections and widenings, remain the construction types. Projected callable inputs use uninhabited or null-only
views; validation still checks those safe views against the original reified contract, including saved fields, returned
functions, bound references, variadics, and suspension.


The execution loop advances the program counter before dispatching an instruction. A prepared choice retains evaluated
labels, enabled states, option destinations, and once-history identifiers. Input checkpoints serialize the graph plus
active frames, operands, generic arguments, prose buffers, and choice snapshots. Loading validates build/profile and
references before execution resumes; completed evaluation is not replayed. Saving first collects the live graph at the
prepared wait. Internal cell/environment positions may change; language bindings and aliases retain their values.

Execution quanta return a resumable `running` status; the ChoiceScript adapter and CLI yield between slices. The adapter
invalidates scheduled tickets when sessions finish, fail, or are replaced. Session callbacks also check attachment
identity. Restoration validates the checkpoint before releasing the previous owned native continuation; invalid input
cannot detach a working session. Hosts can explicitly detach a session before replacing its engine scene. Default
presentation tracks all appended nodes, including submit buttons beside forms, so responding removes only the consumed
controls. Built-ins and native commands still execute synchronously within their own operation. Terminal checked
failures clear pending input, retain the original diagnostic, and release only owned native continuations. Completed
output remains drainable exactly once; the transcript retains presentation history.

Equality uses explicit comparison frames. A candidate in unordered comparison records the current pair-trail length;
failure rolls back assumptions added by that candidate. This prevents both JavaScript recursion overflow and false
matches caused by retaining failed-trial pairs. String traversal stores the original scalar String plus a validated
cursor, while collection traversals retain their selected shallow snapshots. Explicit String conversion uses a work
stack and tracks active ancestors, so deep graphs do not consume the host call stack and repeated aliases remain
independently rendered.

Set and map operations use ephemeral indexes over container arrays. Primitive keys have compatible equality buckets;
composite keys retain conservative structural comparisons. Incremental insertion updates the index, while removal and
clear invalidate it. WeakMap ownership avoids retaining dead containers; indexes are never saved, and checkpoint load or
heap compaction can rebuild them. Insertion order remains in the original arrays.

Progression membership computes the matching index arithmetically while retaining the selected signed search-index
overflow boundary. It does not traverse billions of integers in one synchronous operation. Checkpoint validation
requires a range's tag, direction, emptiness and aligned endpoint to match its construction invariants.

Named frame binding creates a local parameter-position Map on the first named argument. Positional calls allocate no
index. Parameter names are validated as unique before execution; Map lookup also handles names such as `__proto__`
without prototype lookup. The index is transient and adds no saved state.

Call setup uses a named options object. Supplied arguments have already been evaluated and converted in source order;
omitted defaults execute in the compiled callee. Variadic parameters receive a fresh immutable argument list. Generic
null refinements preserve parameter identity until reification; substituted non-null locals and callable results retain
their concrete type across checkpoints.

src/shared.mjs owns shared cell installation and execution of the compiled eager startup plan. Each dependency must
already be initialized when its dependent starts. src/collector.mjs traces root bindings, active frames and operands,
captured environments, receivers, assignment addresses, and traversal snapshots. It compacts reachable cells,
environments, and objects without changing alias relationships. Checkpoints contain initialized shared state and resume
without boot replay.

Restored heap objects are checked in `src/checkpoint-heap.mjs`. Nominal fields must match their declaration's complete
field set, substituted generic types, mutability, initialized state, and variant tag. Collection and entry
representations must match their declared type arguments. Checks inspect references rather than recursively expanding
objects, preserving cyclic aliases. Primitive metadata cannot impersonate another value type.

`src/checkpoint-keys.mjs` then checks stored set elements and map keys. An iterative walk rejects callable keys, mutable
containers, and mutable descendants while retaining shared aliases and immutable cycles. Ordinary equality detects
duplicate saved keys, including floating signed zero; restoration rejects them rather than silently normalizing the
container. These checks finish before replacing an existing host continuation.

## Legacy execution boundary

`src/legacy.mjs` checks host values, installs volatile external proxy cells, and coordinates legacy replies, input
checkpoints, and transfers. `src/legacy/values.mjs` owns strict primitive and plain-enum decoding. Enum eligibility and
allowed case names are cached by definition identity; native Strings are checked against the expected nominal enum
before allocation. Encoding also rejects a same-named case from another enum. `state.mjs` serializes native object
graphs without storing engine callbacks. `input.mjs` prepares native text/number waits and validates responses. A
supplied native host is snapshotted at a Bifoil input checkpoint whenever the program declares native globals or
bridges, including before their first execution. Saving does not perform a native read or start a bridge. Programs with
unused native interfaces can still run without a host until native access is required.

`src/legacy/choicescript.mjs` adapts loading, presentation, and explicit call/transfer boundaries around the supplied
engine's parser and command loop. Its execute router only intercepts active native bridge sessions; ordinary engine
scenes retain their original execution. `src/legacy/node-host.mjs` loads an explicitly supplied engine for terminal
execution and tests. No upstream implementation is copied into these modules.

`src/legacy/output.mjs` publishes completed native paragraphs through an optional host callback. It flushes pending VM
output before engine-owned images/charts and direct line breaks. Empty native returns do not publish a boundary, so
inline calculations cannot split prose. The browser adapter records these paragraphs in the transcript and drains them
once before the native renderer runs. Fresh input restoration reinstalls callbacks without replaying presentation.
Custom native factories receive the same publisher through their third options argument.

`tools/browser-save.mjs` belongs to the original acceptance host. It stores rendered page HTML separately from the VM
checkpoint, omits input controls, and accepts older raw saves. The host validates/attaches execution before restoring
that presentation and rebuilding controls. VM/checkpoint formats remain unchanged; production UI persistence remains a
host responsibility.


## Maintaining a change

Keep primitive values, heap operations, frame binding, presentation, and checkpoint validation in their owning modules.
Share primitive construction and checks rather than copying them between handlers. Preserve the compiler/runtime
instruction contract when changing either side.

Ordinary Node tests need no package installation:

```sh
node --test test/*.test.mjs
```

The optional engine test requires an explicit `CHOICESCRIPT_ENGINE` path. Original generated protocol fixtures are kept
with the tests. End-to-end language cases are run by the compiler's explicit-path conformance tool.

The local Prettier configuration uses a 120-column width with other defaults. Formatting and passing tests are
maintenance checks; they do not establish full steering conformance or release readiness.


`src/program-limits.mjs` owns the loaded function and instruction guards used by both inline validation and package
assembly. These bound code tables separately from execution heap, call depth, and checkpoint limits. Boundary tests
reject oversized inline and combined package tables before execution.
