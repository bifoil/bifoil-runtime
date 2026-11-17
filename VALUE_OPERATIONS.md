# Value operations and host stack use

Compiled instructions call ordinary runtime operations; collection or object depth must not become JavaScript call stack
depth. Equality, explicit String rendering, and collection conversion own their traversal frames. Calls bind large
argument groups through loops rather than spreading an input array into a JavaScript function invocation.

## Collection conversion and copying

[The conversion evaluator](src/conversions.mjs) owns one pending-frame stack shared by implicit conversions and explicit
collection-copy methods. Frames retain a source container, requested reified type, element/entry position, and partial
output. Only one next child is scheduled at a time; the work stack grows with nesting rather than container width. The
operation remains synchronous within its compiled instruction, as before.

An accepted subtype view retains its value and identity. Approved Int-to-Float and Char-to-String widenings construct
primitive results. Nullable application preserves null and converts a present value. Other container conversions check
family compatibility and mutable invariance, then use the existing projected-type reification rules.

Implicit map conversion visits entries in insertion order: convert a key, check it against earlier converted keys, then
convert its value. Implicit set conversion converts elements in order and coalesces equal results, preserving the first
insertion. Explicit copy methods always allocate the root container, including when its type is unchanged. They retain
the already-checked source inventory without another structural duplicate search only when key types are unchanged. A
map copy with changed key types checks duplicates before converting each value. Child conversions use the same ordinary
conversion rules in both paths. Explicit root copying remains distinct from an implicit assignment between mutable
collections with different type arguments.

Copying does not recursively freeze referenced mutable values. A compatible contained value keeps its reference; cycles
and repeated aliases therefore remain shared. A conversion required at an immutable contained layer creates that layer's
converted container. Projected covariant arguments retain available concrete identity; invariant slots retain the
requested types. The evaluator does not add numeric casts, implicit adapters, or new conversion categories.

[Direct controls](test/conversions.test.mjs) cover 61 nested collection layers with nullable numeric leaves, 300,000
values, root freshness, mutable invariance, projected identity, insertion order, and cyclic shallow aliases. Existing
source-free collection and projection cases exercise the same operations through compiler output and checkpoints.

## Equality, rendering, and argument groups

[Structural equality](src/equality.mjs) uses explicit ordered/unordered comparison frames and cycle-pair tracking.
Failed unordered candidates roll back only their own assumptions. [Depth controls](test/equality.test.mjs) compare 6,000
nested nominal/set levels using ordinary and exact equality and reject cross-contaminated unordered matches.

[Explicit String rendering](src/rendering.mjs) uses a pending-value stack and active-ancestor tracking. It marks true
cycles while rendering repeated aliases independently. [Rendering controls](test/rendering.test.mjs) exercise 12,000
nested containers, cyclic aliases, and map-entry order.

[Call binding](src/frames.mjs) expands variadic groups into their fresh immutable List through loops. Native argument
encoding and completed output likewise use iteration. The [large-group control](test/legacy.test.mjs) passes 300,000
arguments through a variadic call and checks an equally large native output batch without host argument-count limits.

## Large checkpoint graphs

[The checkpoint control](test/checkpoint-large-graphs.test.mjs) retains a 20,000-node nominal ring, 60,000 field
bindings, one shared mutable payload, two aliases to the root, and a suspended captured-function call. Four consecutive
save/restore rounds each validate every node and the shared payload. The serialized checkpoint exceeds 8 MiB; its
representation still fits the existing 16 MiB checkpoint guard.

After each restore, mutate the shared payload, allocate unreachable containers/cells/environments, and collect them. The
control proves their reclamation without losing the ring or root aliases. Resuming the original call produces its
expected result and effects. [Adapter lifecycle controls](test/adapter-lifetime.test.mjs) separately reject stale
callbacks, preserve working sessions on rejected restores, and release only owned continuations during replacement or
detachment. [Lazy package controls](test/lazy-packages.test.mjs) apply those lifetime checks to pending code reads.

This is a direct VM/lifecycle regression, separate from the [original browser save host](BROWSER_ACCEPTANCE.md),
production persistence services, and target-scale acceptance.

## Remaining boundaries

Runtime type descriptors retain their separately checked depth limit. Metadata type substitution and subtype checking
operate within that admitted descriptor depth; this document does not claim arbitrary-depth type syntax. Heap-object,
call-depth, instruction, package, and checkpoint guards remain separate. None of these controls proves target-scale
source capacity, a bound on total JavaScript physical memory, or the compiler's aggregate memory/timing contract.


## Declared views and exact comparison

Profile v3 uses [comparison views](src/comparison-views.mjs) to derive child types and distinguish memoized pair
contexts. [The iterative comparator](src/equality.mjs) keeps those views separate from runtime value identities.
Covariant views can compare exactly equal to independently constructed values exposed through the same types, while
subsequent type tests still see each original construction type. Primitive kinds, active variants, static capability
requirements, and null rules retain their contracts. V1/v2 comparisons keep their original behavior.

The view cache is local to one comparison. Field-type substitution is reused across repeated nominal nodes, and
unordered trials roll back pair facts while preserving their context identities. Hidden positions use retained value
types. The runtime tests cover a repeated object pair reached through both broad and hidden views, unordered reordering,
cyclic graphs with different sharing layouts, and 6,000 nested data nodes.

## Explicit text conversion

Primitive rendering is shared by interpolation and explicit String conversion. The current v3 profile retains the
selected case in enum rendering; v1/v2 output remains unchanged. Composite conversion follows active ancestor paths, so
cycles receive a marker while completed repeated aliases render again. It uses an owned work stack. The [language text
contract](../bifoil-language/text-semantics.md) defines spellings, conversion APIs, whitespace, and representation
boundaries; diagnostic rendering is not a save format.

## Collection method interfaces

The [language operation contract](../bifoil-language/collection-operations.md) defines method names and results.
Current containsKey calls expose key; earlier compiled calls carrying element remain executable. Source-level names
are checked by the compiler. Plain indexed writes check final bounds after the RHS; compound updates read/check before
the RHS and check again when writing. Entry fields are snapshot bindings, while referenced contents keep normal sharing.

## Pinned integer progression membership

The [language progression contract](../bifoil-language/progression-membership.md) pins the official Kotlin source and
derives the constant-work result/index-overflow calculation. Runtime behavior is unchanged; source checking now
requires integer queries. Exact exhaustion at the final valid index remains distinct from attempting another element.
