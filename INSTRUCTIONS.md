# V3 instruction contracts

This is the complete opcode contract for the development bifoil-vm.v3 producer/consumer pair. The [profile
protocol](PROTOCOL.md) owns supported artifact combinations, generic/value encodings, package transport, and checkpoint
schemas. The native compiler's Op enum and the portable runtime's opcode inventory must both match this document.
Historical v1/v2 fixtures retain their documented compatibility behavior; new compilation uses the v3 requirements.

## Representation and static obligations

Each instruction has an op tag, the payload below, and span containing a logical Bifoil file and positive one-based
physical line. Local target/fallback addresses index the same body and must remain in bounds. Function/type/binding
identities resolve against the linked checked inventory. IDs for traversals/operand marks are nonnegative integers
local to an activation. Type fields are complete checked types, substituting generic parameters from the activation.
Optional payloads have a question suffix below; none means no opcode-specific field. Rust Option fields without an
omission rule, including choose fallback and construct tag, encode an explicit null when absent.

S denotes the existing operand stack; the rightmost operand is topmost. args[n] and field values[n] occur in source
evaluation order. The result of a call arrives only when the callee returns. No opcode silently reevaluates a source
expression. Assignment operations produce no expression value. Producers are responsible for static type eligibility,
definite assignment, effect/capture proofs, visibility, overload selection, and the permitted conversions before issuing
these operations. Runtime checks defend the specified dynamic failure boundaries; envelope validation is not an
independent proof of every compiler static obligation. Instruction validation and untrusted-artifact hardening remain
separate from publisher authentication and from this contract's opcode coverage.

## Complete opcode inventory

| Opcode | Payload | Operand contract | State, checks, and control effects |
| --- | --- | --- | --- |
| `constant` | `ty, value` | `S -> S,v:ty` | Push a validated primitive constant. Callable/heap identities use dedicated operations. |
| `load` | `name` | `S -> S,v:T` | Read the resolved cell; require initialization. Volatile legacy cells revalidate the native value on every read. |
| `declare` | `name, ty, mutable` | `S,v:ty -> S` | Create a fresh current-scope cell after the producer has performed any required conversion. |
| `uninitialized` | `name, ty, mutable` | `S -> S` | Create an empty typed cell. Reading fails until initialization; an immutable cell may be assigned once. |
| `store` | `name` | `S,v:T -> S` | Write an assignable cell with a compatible value; shared cells must already have completed startup initialization. |
| `closure` | `name, function, captures?` | `S -> S` | Bind a named local callable to the current shared cells, including forward uninitialized cells; never read captures during creation. |
| `function_value` | `function, captures?` | `S -> S,f` | Create an anonymous/local callable retaining selected capture cells and enclosing reified arguments. |
| `pop` | `none` | `S,v -> S` | Discard one value without changing its aliases. |
| `dup` | `none` | `S,v -> S,v,v` | Duplicate the value descriptor; referenced objects/cells remain shared. |
| `widen` | `none` | `S,Int -> S,Float` | Perform the exact Int-to-Float value conversion. |
| `convert` | `ty` | `S,v -> S,converted:ty` | Apply an approved checked scalar/nullable/container conversion; copy containers only when that conversion requires it. |
| `unary` | `operator` | `S,a -> S,result` | Apply ! to Boolean or checked unary minus to Int/Float. |
| `binary` | `operator` | `S,a,b -> S,result` | Apply the selected checked arithmetic, fairmath, comparison, or membership operation. Operands have already evaluated left to right. |
| `exact_compare` | `left_type, right_type, negate` | `S,a,b -> S,Boolean` | V3 exact equality uses declared comparison views and recursive exact values, preserving retained construction identities. |
| `jump` | `target` | `S -> S` | Set the current body PC to the checked local instruction address. |
| `jump_false` | `target` | `S,Boolean -> S` | Branch when false; consume the Boolean on either path. |
| `jump_true` | `target` | `S,Boolean -> S` | Branch when true; consume the Boolean on either path. |
| `jump_null` | `target, when_null` | `S,v -> S` | Consume one tested value and branch when its nullness matches when_null. Duplicate beforehand when a later path needs the value. |
| `enter` | `none` | `S -> S` | Create a child lexical environment. Its cells may outlive exit when captured. |
| `exit` | `none` | `S -> S` | Return to the parent environment; reject leaving the root. |
| `unwind` | `count` | `S -> S` | Leave exactly count lexical environments; loop/transfer lowering handles operand/prose state separately. |
| `default` | `name, target` | `S -> S` | Skip default code if this activation already has the supplied parameter. Otherwise execute its default in declaration order. |
| `specialize` | `args` | `S,f -> S,specialized f` | Resolve and attach the declared generic argument map to a function template; preserve receiver and captured environment. |
| `call` | `names, direct, spreads?` | `S,f,args[n] -> S,result` | Capture callable first, then evaluate/convert supplied arguments. Enter a fresh activation; install omitted defaults afterward. A suspend target requires a suspend caller. |
| `return` | `none` | `S,result:R -> caller,R` | Check the substituted result type, close the activation prose scopes, and deliver its result. A scene with no caller finishes the story. |
| `legacy_call` | `target, arguments` | `S,args[n] -> S,result` | A generated wrapper encodes typed arguments and checks the native return. It may prepare a native input wait or explicitly transfer; it cannot trust an unknown result. |
| `scene_call` | `names, direct, transfer` | `S,Scene,args[n] -> S,Unit` | Visit creates a fresh scene visit. Transfer removes the current visit and its function frames, preserving earlier scene callers; it never resumes the replaced path. |
| `format` | `count` | `S,renderable[n] -> S,String` | Render non-null primitive operands in source order and check combined text size before joining. It performs no calls or suspension itself. |
| `print` | `none` | `S,String -> S` | Emit one completed paragraph. Presentation escaping belongs to the host; completed output is not replayed. |
| `prose_start` | `none` | `S -> S` | Flush outer prose and push a new prose buffer for this lexical prose context. |
| `prose_text` | `none` | `S,String -> S` | Append to the active paragraph with one joining space when needed; check combined size before allocation. |
| `prose_flush` | `none` | `S -> S` | Emit the active paragraph once, clear its buffer, and retain the prose context. |
| `prose_end` | `none` | `S -> S` | Flush and remove the active prose context. |
| `prose_unwind` | `depth` | `S -> S` | Flush/remove prose contexts down to the activation prose base plus depth, preserving older caller contexts. |
| `begin_choice` | `none` | `S -> S` | Start an empty option snapshot in this activation. |
| `unused` | `site` | `S -> S,Boolean` | Read playthrough-wide once history without consuming it. Producers branch around all preparation of a consumed site. |
| `offer` | `target, once?` | `S,Boolean,String -> S` | Append the already prepared enabling result, label, destination, and optional once site; hidden options never reach this operation. |
| `choose` | `fallback` | `S -> S` | Flush prose. In a suspend activation, wait on the retained selectable snapshot; otherwise branch to fallback or fail. Selection consumes once history and jumps to the body. |
| `member` | `name, ty, function?` | `S,receiver -> S,member:ty` | Read a field/property or bind the selected method to this receiver once. Substituted result types preserve checked generic views. |
| `index` | `none` | `S,receiver,key -> S,value` | Index String/List by nonnegative scalar/element Int or Map by a compatible key. Check bounds; absent Map keys yield null. |
| `address_member` | `name` | `S,receiver -> S,address` | Capture one mutable data-field address; do not read its value or reevaluate its receiver. |
| `address_index` | `none` | `S,receiver,key -> S,address` | Capture a mutable List/Map address without a plain-write bounds read. Receiver and key have already evaluated once. |
| `read_address` | `none` | `S,address -> S,address,value` | Read and check a captured compound-update target before evaluating the RHS; retain its address for the final write. |
| `write_address` | `none` | `S,address,value -> S` | Check the destination again at write time, convert before this operation, and write through the captured address without reevaluation. |
| `assert_present` | `none` | `S,T? -> S,T` | Fail on null; otherwise retain the original non-null value and identity. |
| `type_test` | `ty, negate` | `S,v -> S,Boolean` | Test the retained runtime type through genuine subtype relationships, including reified arguments; never widen scalars or copy containers. |
| `cast` | `ty, safe` | `S,v -> S,typed value` | Retain a matching value. A mismatch yields null when safe, otherwise fails; no conversion adapter is constructed. |
| `begin_collection` | `ty` | `S -> S,builder:ty` | Allocate a fresh typed List/Set/Map literal container. Its producer-controlled initialization may fill an immutable result before exposure. |
| `collection_add` | `none` | `S,builder,item -> S,builder` | Append a compatible List element or coalesce an equal stable Set member in first-insertion order. |
| `check_key` | `none` | `S,map,key -> S,map,key` | Reject a duplicate Map literal key before the producer evaluates its value. |
| `collection_put` | `none` | `S,map,key,value -> S,map` | Append the checked key/value pair after duplicate checking; literal order is retained. |
| `construct` | `ty, fields, tag` | `S,field values[n] -> S,instance:ty` | Allocate nominal data/variant/enum storage with the complete declared fields, substituted field types, mutability, and optional variant tag. |
| `range` | `descending, exclusive` | `S,Int start,Int end -> S,range` | Build the selected ascending or descending progression; reject invalid ascending bounds. Exclusive ascending bounds exclude end. |
| `range_step` | `none` | `S,range,Int step -> S,progression` | Require a positive step, retain direction, and calculate the last reachable element without endpoint overflow. |
| `iter_start` | `id` | `S,iterable -> S` | Store a traversal by activation-local ID. Snapshot collection elements/entries; immutable String uses a scalar-boundary cursor and ranges use bounded integer state. |
| `iter_next` | `id, name, ty, target` | `S -> S` | On exhaustion branch to target. Otherwise create the fresh immutable iteration binding in the producer-created iteration scope and advance once. |
| `iter_end` | `id` | `S -> S` | Release the named activation traversal; retained element aliases keep their ordinary semantics. |
| `stack_mark` | `id` | `S -> S` | Record operand depth for this loop. The mark ID must be unique among active marks. |
| `stack_reset` | `id` | `S,partial operands -> S` | Restore the marked operand depth and drop nested marks for break/continue without dropping surrounding-expression operands. |
| `stack_end` | `id` | `S -> S` | Remove the innermost matching loop operand mark after loop completion. |
| `unreachable` | `none` | `S -> no continuation` | Fail if a path proven impossible by static checking is reached. It produces no value. |

## Evaluation, effects, and suspension

Calls and scene destinations capture their callable/receiver before arguments. Supplied arguments are evaluated and
converted in written order; omitted defaults follow parameter order. The producer lowers short circuiting, safe
access/index/call, Elvis fallback, choice visibility/once filtering, if/when branches, and early control
expressions into
these ordinary jumps and scopes. Fairmath grouping, overload ranking, Unit-context result discarding, and no-copy
inference are static/lowering rules rather than additional runtime opcodes. Fields/defaults/copy helpers use ordinary
functions and construct operations; shared initializers use the checked dependency-first startup plan.

Only choose, a suspending call/scene visit, or a supported suspending legacy call may prepare player input. Function
signatures carry the checked suspension effect; prose/option preparation cannot introduce suspension. A code-cache wait
or execution quantum yield can interrupt machine work without becoming a saveable player-input checkpoint. Operand
values, frames, arguments already evaluated, captures, traversal cursors, prose contexts, marks, and prepared snapshots
retain their progress. Full same-build checkpoint validation follows the profile protocol; code-cache contents are not
saved and completed expression/choice preparation is not replayed.

## Failure and continuation ownership

Checked failures retain the current instruction's original Bifoil span, stop the story, cancel owned legacy work,
clear active continuations/code waits, and preserve completed output for one drain. Invalid host selection/submission
can reject at the prepared wait without running story instructions. Returns and scene transfers separately unwind the
activation's prose and lexical state. Early loop control additionally restores its operand mark; collection does not
change shared-cell relationships or language equality. Save/restore rejects profile/build mismatches before applying
external host state. Runtime limits and target-scale resource acceptance are separate from opcode semantics.

## Executable evidence

[Program validation](src/program-instructions.mjs), [core execution](src/vm.mjs), and [heap/story
execution](src/operations.mjs) implement the current consumer. [Conformance](../bifoil-language/conformance/README.md)
checks source-produced operation interactions, including source-free modules and restored input waits in both output
modes. [Runtime tests](test) cover malformed envelopes, stack/loop/prose control, heap relationships, and checkpoint
shape validation. This inventory defines accepted instruction behavior; it does not claim that every malformed artifact
or every host platform has completed acceptance.
